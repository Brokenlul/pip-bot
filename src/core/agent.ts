import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config.js';
import { NormalizedMessage, NormalizedReply, SourceCitation } from '../adapters/platform.js';
import { ToolRegistry, ToolContext } from '../data/registry.js';
import { cryptoPriceTool } from '../data/coingecko.js';
import { fundingRateTool } from '../data/hyperliquid.js';
import { fedCalendarTool } from '../data/fed-calendar.js';
import { recentQuestionsTool } from '../data/memory-tool.js';
import { buildReply } from './formatter.js';
import { lookupCache, persistQA, ensureGuild, incrementUsage, isMemoryOn } from '../memory/store.js';

const MAX_AGENT_STEPS = 6;

const SYSTEM_PROMPT = `You are **Paul**, a sharp research analyst embedded in a crypto / finance / trading community.

Your job is to give grounded, accurate, useful answers to questions about markets, macro events, crypto assets, and derivatives.

Style:
- Terse. No fluff. No throat-clearing. Speak like a desk analyst writing to a sharp trader, not a customer-service bot.
- When you have live data, lead with the numbers. When you don't, say so plainly.
- Lean toward the differentiated read: funding, open interest, what the market is pricing in — not just spot price.

Hard rules:
- Never give financial advice. Never use signal language ("buy", "sell", "send it", "ape"). Describe state and tradeoffs.
- Never invent numbers. If a tool fails, say a tool failed and offer what you do know.
- Always prefer calling a tool over recalling from training data when a tool exists for the question.
- When the user asks about server history ("what have we asked about", "what's been discussed"), use the recent_guild_questions tool.

The current UTC date is provided in the user message. The system will append sources + a disclaimer to your answer — do NOT add your own disclaimer or "as of" line.`;

function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg
    .register(cryptoPriceTool)
    .register(fundingRateTool)
    .register(fedCalendarTool);
  if (isMemoryOn()) reg.register(recentQuestionsTool);
  return reg;
}

let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (!anthropic) anthropic = new Anthropic({ apiKey: getConfig().ANTHROPIC_API_KEY });
  return anthropic;
}

/**
 * Run one user turn through the agent loop.
 * Honors the moat habit: memory read happens BEFORE the loop,
 * memory write happens AFTER, even on partial failures.
 */
export async function answer(msg: NormalizedMessage): Promise<NormalizedReply> {
  const cfg = getConfig();

  // Side-effects that should not block the answer if they fail
  await ensureGuild(msg.guildId, msg.guildName).catch((e) =>
    console.warn(`[memory] ensureGuild: ${(e as Error).message}`),
  );
  incrementUsage(msg.guildId).catch((e) =>
    console.warn(`[memory] incrementUsage: ${(e as Error).message}`),
  );

  // 1. Semantic cache check (M4)
  if (isMemoryOn()) {
    const cached = await lookupCache(msg.guildId, msg.text).catch(() => null);
    if (cached) {
      const ageMs = Date.now() - cached.cachedAt.getTime();
      const ageMin = Math.max(1, Math.round(ageMs / 60_000));
      return buildReply({
        body: `${cached.answer}\n\n_(served from server memory · matched a question asked ~${ageMin} min ago)_`,
        sources: cached.sources,
        asOf: cached.cachedAt,
      });
    }
  }

  // 2. Agent loop with tools
  const registry = buildRegistry();
  const ctx: ToolContext = { guildId: msg.guildId, userId: msg.userId };
  const citations: SourceCitation[] = [];

  const tools = registry.anthropicTools();
  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: 'user',
      content: `[server: ${msg.guildName ?? msg.guildId} · user: ${msg.userName ?? msg.userId} · utc: ${new Date().toISOString()}]\n\n${msg.text}`,
    },
  ];

  let finalText = '';
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const resp = await getClient().messages.create({
      model: cfg.ANSWER_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    // Always echo the assistant turn back into the transcript
    messages.push({ role: 'assistant', content: resp.content });

    if (resp.stop_reason !== 'tool_use') {
      finalText = resp.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      break;
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      const tool = registry.get(block.name);
      if (!tool) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: `Unknown tool: ${block.name}`,
        });
        continue;
      }
      try {
        const input = tool.validate(block.input);
        const out = await tool.execute(input, ctx);
        citations.push(tool.citation(input, out));
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(out),
        });
      } catch (e) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          is_error: true,
          content: `Tool ${block.name} failed: ${(e as Error).message}`,
        });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  if (!finalText) {
    finalText = "I couldn't complete a grounded answer for that — a downstream tool kept failing. Try again in a moment.";
  }

  const reply = buildReply({ body: finalText, sources: dedupe(citations) });

  // 3. Memory write (M4) — fire-and-forget, never blocks the reply
  if (isMemoryOn()) {
    persistQA({
      guildId: msg.guildId,
      userId: msg.userId,
      question: msg.text,
      answer: finalText,
      sources: reply.sources,
    }).catch((e) => console.warn(`[memory] persistQA: ${(e as Error).message}`));
  }

  return reply;
}

function dedupe(sources: SourceCitation[]): SourceCitation[] {
  const seen = new Set<string>();
  const out: SourceCitation[] = [];
  for (const s of sources) {
    const k = `${s.label}|${s.url ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}
