import { z } from 'zod';
import { Tool, ToolContext, zValidator } from './registry.js';
import { recentQuestions } from '../memory/store.js';

/**
 * Lets Claude answer "what have we asked about lately" from per-guild memory.
 * This is what proves the moat to the user — Paul references the *server's*
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
    "Recall the recent questions and answers asked in THIS Discord guild. Use this when the user asks meta questions like 'what have we asked about lately', 'what's been discussed', 'remind us what came up before', or to ground a follow-up in recent server history. Do NOT use for the user's own factual question — use the data tools for that.",
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many recent items.' },
    },
  },
  validate: zValidator(InputSchema),
  execute: async (input, ctx: ToolContext) => {
    const items = await recentQuestions(ctx.guildId, input.limit ?? 8);
    return {
      count: items.length,
      recent: items.map((i) => ({
        question: i.question,
        answered: i.answer.length > 240 ? `${i.answer.slice(0, 240)}…` : i.answer,
        asked_at_iso: i.askedAt.toISOString(),
      })),
    };
  },
  citation: () => ({ label: 'Server memory' }),
};
