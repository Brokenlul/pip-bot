import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { trendingTopics } from '../memory/pulse.js';

/**
 * Cross-community situational awareness. Returns the anonymized aggregate of
 * which assets / macro themes people are asking Pip about across ALL servers
 * and DMs — never any raw question, community, or user. Lets Pip say "funding
 * and SOL are what the desk is chewing on right now" to sharpen a read.
 */
const InputSchema = z.object({
  days: z.number().int().min(1).max(30).optional().describe('Trailing window in days (default 7).'),
  limit: z.number().int().min(1).max(25).optional().describe('How many top topics (default 12).'),
});
type Input = z.infer<typeof InputSchema>;

interface Output {
  window_days: number;
  trending: Array<{ topic: string; mentions: number }>;
}

export const marketPulseTool: Tool<Input, Output> = {
  name: 'market_pulse',
  description:
    "The anonymized cross-community pulse: which assets and macro themes are being asked about most across ALL servers and DMs right now. Use it to add situational awareness to a read (e.g. 'funding and SOL are unusually hot this week') or when the user asks what's trending / what people are watching. Returns aggregate topic counts only — no raw questions, no communities, no users.",
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'integer', minimum: 1, maximum: 30, description: 'Trailing window in days (default 7).' },
      limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many top topics (default 12).' },
    },
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    const days = input.days ?? 7;
    const trending = await trendingTopics(days, input.limit ?? 12);
    return { window_days: days, trending };
  },
  citation: () => ({ label: 'Cross-community pulse' }),
};
