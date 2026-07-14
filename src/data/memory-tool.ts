import { z } from 'zod';
import { Tool, ToolContext, zValidator } from './registry.js';
import { recentQuestions } from '../memory/store.js';
import { extractStats } from '../core/formatter.js';

/**
 * Lets Claude answer "what have we asked about lately" from per-guild memory.
 * This is what proves the moat to the user — Pip references the *server's*
 * history, not a generic LLM's vague "I don't know".
 */
const InputSchema = z.object({
  limit: z.number().int().min(1).max(20).optional().describe('How many recent Q&As to recall (default 8).'),
});
type Input = z.infer<typeof InputSchema>;

interface Output {
  count: number;
  recent: Array<{ question: string; answered: string; asked_at_iso: string }>;
}

export const recentQuestionsTool: Tool<Input, Output> = {
  name: 'recent_guild_questions',
  description:
    "Recall THIS user's own recent questions and answers with you. Use it when they ask meta questions like 'what have I asked lately', 'what did we cover', 'remind me what came up before', or to ground a follow-up in their recent history. Scoped to this user only — never another trader's questions. Do NOT use for a fresh factual question — use the data tools for that.",
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many recent items.' },
    },
  },
  validate: zValidator(InputSchema),
  execute: async (input, ctx: ToolContext) => {
    // Privacy: scope recall to the requesting user, not the whole guild.
    const items = await recentQuestions(ctx.guildId, input.limit ?? 8, ctx.userId);
    return {
      count: items.length,
      recent: items.map((i) => {
        // Flatten a stored [[STATS]] block back to plain "Label: value" text —
        // this feeds back into the model as tool JSON, not a rendered embed.
        const { fields, body } = extractStats(i.answer);
        const flat = fields.length
          ? `${fields.map((f) => `${f.name}: ${f.value}`).join(', ')}. ${body}`
          : body;
        return {
          question: i.question,
          answered: flat.length > 240 ? `${flat.slice(0, 240)}…` : flat,
          asked_at_iso: i.askedAt.toISOString(),
        };
      }),
    };
  },
  citation: () => ({ label: 'Server memory' }),
};
