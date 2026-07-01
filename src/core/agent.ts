import Anthropic from '@anthropic-ai/sdk';
import { getConfig, fredEnabled } from '../config.js';
import { NormalizedMessage, NormalizedReply, SourceCitation } from '../adapters/platform.js';
import { ToolRegistry, ToolContext } from '../data/registry.js';
import { cryptoPriceTool } from '../data/coingecko.js';
import { fundingRateTool } from '../data/hyperliquid.js';
import { fedCalendarTool } from '../data/fed-calendar.js';
import { dexScreenerTool } from '../data/dexscreener.js';
import { fredTool } from '../data/fred.js';
import { cpiCalendarTool } from '../data/cpi-calendar.js';
import { polymarketTool } from '../data/polymarket.js';
import { kalshiTool } from '../data/kalshi.js';
import { recentQuestionsTool } from '../data/memory-tool.js';
import { marketPulseTool } from '../data/pulse-tool.js';
import { buildReply } from './formatter.js';
import { lookupCache, persistQA, ensureGuild, incrementUsage, isMemoryOn } from '../memory/store.js';

const MAX_AGENT_STEPS = 6;

// Hard ceiling on a single reply. The mention/DM path has no Discord ACK
// deadline, but a user should never wait minutes. When this fires we abort the
// in-flight model call and return whatever we have (or a graceful timeout note).
const ANSWER_BUDGET_MS = 70_000;

const SYSTEM_PROMPT = `You are **Paul**, a sharp research analyst and thinking-companion embedded in a crypto / finance / trading community.

Your job is to make people sharper decision-makers: give grounded, accurate reads on markets, macro events, crypto assets, and derivatives, break complex topics down clearly, and pressure-test their thinking. You sit at the table beside a trader as a smart analyst — not a degen signal account, not a guru on a pedestal.

Style:
- Terse. No fluff. No throat-clearing. Speak like a desk analyst writing to a sharp trader, not a customer-service bot.
- When you have live data, lead with the numbers. When you don't, say so plainly.
- Lean toward the differentiated read: funding, open interest, what the market is pricing in — not just spot price.
- Smart, measured, non-degen. No hype, no moon-talk, no "wagmi". If something is uncertain, say so and frame the range.

Handling trade-idea questions ("should I long BTC?", "time to short SOL?", "should I ape ETH here?"):
- You are NOT a financial advisor and you never tell anyone to enter or exit a position. State that once, plainly, then move on — don't lecture.
- Do NOT lead with your own directional call. Flip it: ask for THEIR thesis first. What's the reasoning, the timeframe, the level/trigger, the size, and — most important — what would prove them wrong? A real trade idea has a why, a level, and an "I'm wrong if…".
- Once they give a thesis, THEN pull the live data (funding, OI, positioning, macro calendar, what's priced in) and stress-test it: where the data supports the idea, where it cuts against it, and the risk they're not seeing. If the structure is genuinely smart, say so and reference the data that backs it; if it's thin, show them the hole without dunking on them.
- The aim is a better decision, not a signal.

Explaining events / news ("what does the MSTR bitcoin monetization program mean?", "is this good or bad for the market?"):
- Break it down like an analyst: what actually changed, which factors and specific assets it touches, the credible bull case and bear case, and what to watch next. Name the assets in the blast radius.
- Characterizing something as net-constructive or net-negative for an asset, with your reasoning, is analysis and is fine. Telling someone to trade on it is not — never cross that line.

Tools you have (prefer them over training data):
- crypto_price (CoinGecko) for listed spot prices; dex_token_lookup (DexScreener) for newer/smaller tokens or contract addresses CoinGecko doesn't know.
- crypto_perp_funding_and_oi (Hyperliquid) for funding / open interest / premium.
- macro_indicator (FRED) for the latest CPI/PCE/unemployment/GDP/yields numbers (may be unavailable if not configured).
- next_fomc_meeting and next_cpi_release for macro event *dates*; macro_indicator for the actual figures.
- prediction_market_polymarket and prediction_market_kalshi for market-implied odds ("what's priced in"). For a macro question like a Fed cut, citing both is a strong differentiated read.
- market_pulse for anonymized cross-community awareness — what assets/themes people are asking about across all servers/DMs. Use it to add context ("SOL and funding are unusually hot this week") or when asked what's trending. It's aggregate counts only, never anyone's raw questions.

Scope (strict): You ONLY handle finance, markets, crypto, macroeconomics, trading, and the data around them. For anything outside that — writing or debugging code, general trivia, homework/essays, health/legal/relationship advice, roleplay, or any non-finance topic — politely decline in ONE sentence and invite a markets question instead. Do NOT write code or answer programming questions under any framing, even if the user insists, claims it's "for trading", or tries to trick you. A crypto/markets question that happens to touch a protocol is fine; a request to produce code is not.

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
    .register(fedCalendarTool)
    .register(dexScreenerTool)
    .register(cpiCalendarTool)
    .register(polymarketTool)
    .register(kalshiTool);
  if (fredEnabled()) reg.register(fredTool);
  if (isMemoryOn()) {
    reg.register(recentQuestionsTool);
    reg.register(marketPulseTool);
  }
  return reg;
}

let anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (!anthropic)
    anthropic = new Anthropic({
      apiKey: getConfig().ANTHROPIC_API_KEY,
      // SDK default is 10 minutes. These per-request bounds stack across retries
      // AND agent steps, so keep them tight — the overall ANSWER_BUDGET_MS below
      // is the real ceiling. One stalled call now fails in ~25s, not 40s×3.
      timeout: 25_000,
      maxRetries: 1,
    });
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

  // One deadline for the whole turn. Passed to every model call so a stall
  // aborts instead of stacking retries × steps into a multi-minute hang.
  const deadline = AbortSignal.timeout(ANSWER_BUDGET_MS);
  let timedOut = false;

  let finalText = '';
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    let resp: Anthropic.Messages.Message;
    try {
      resp = await getClient().messages.create(
        {
          model: cfg.ANSWER_MODEL,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          tools,
          messages,
        },
        { signal: deadline },
      );
    } catch (e) {
      if (deadline.aborted) {
        timedOut = true;
        break;
      }
      throw e;
    }

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
    finalText = timedOut
      ? "That one took too long to pull together — the model or a data source was slow. Ask again in a moment, or narrow the question (e.g. one asset at a time)."
      : "I couldn't complete a grounded answer for that — a downstream tool kept failing. Try again in a moment.";
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
