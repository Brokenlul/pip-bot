import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';

/**
 * Polymarket (Gamma API) — prediction-market odds. Keyless.
 * This gives Pip "what the market is pricing in" reads, e.g.
 * "Polymarket has a July Fed hold at 80%". `public-search` supports free text.
 * Docs: https://docs.polymarket.com/
 */

const InputSchema = z.object({
  query: z.string().min(1).describe('What to find markets about, e.g. "Fed July", "BTC 150k", "US recession 2026".'),
});
type Input = z.infer<typeof InputSchema>;

interface MarketOdds {
  label: string;
  outcomes: { name: string; probability_pct: number }[];
}

interface Output {
  event_title: string;
  outcomes: MarketOdds[];
  volume_usd: number;
  source_url: string;
}

interface GammaMarket {
  question?: string;
  groupItemTitle?: string;
  outcomes?: string; // JSON string: ["Yes","No"]
  outcomePrices?: string; // JSON string: ["0.8","0.2"]
  volume?: string;
  closed?: boolean;
}

interface GammaEvent {
  title?: string;
  slug?: string;
  volume?: number;
  markets?: GammaMarket[];
}

const cache = makeCache<Output>(60_000); // 60s

function parseJsonArray(s: string | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export const polymarketTool: Tool<Input, Output> = {
  name: 'prediction_market_polymarket',
  description:
    'Get current Polymarket prediction-market odds (implied probabilities) for an event by free-text search. Use for "what is the market pricing for a Fed cut", "odds of X", "what does Polymarket say about...". Returns the best-matching event and its outcome probabilities.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Free-text description of the event (e.g. "Fed July decision", "BTC above 150k").',
      },
    },
    required: ['query'],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    const q = input.query.trim();
    return withRetry(async () => {
      return cache.wrap(q.toLowerCase(), async () => {
        const url = `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(q)}&limit_per_type=5`;
        const res = await fetchWithTimeout(url);
        if (!res.ok) throw new Error(`polymarket search ${res.status}`);
        const data = (await res.json()) as { events?: GammaEvent[] };
        const events = (data.events ?? []).filter((e) => (e.markets ?? []).some((m) => !m.closed));
        const event = events[0];
        if (!event) throw new Error(`No open Polymarket events found for "${q}"`);

        const open = (event.markets ?? []).filter((m) => !m.closed);
        // Highest-volume markets first, cap to keep the reply tight.
        open.sort((a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0));
        const outcomes: MarketOdds[] = open.slice(0, 6).map((m) => {
          const names = parseJsonArray(m.outcomes);
          const prices = parseJsonArray(m.outcomePrices);
          return {
            label: m.groupItemTitle || m.question || 'outcome',
            outcomes: names.map((n, i) => ({
              name: n,
              probability_pct: Math.round((Number(prices[i] ?? '0') || 0) * 1000) / 10,
            })),
          };
        });

        return {
          event_title: event.title ?? q,
          outcomes,
          volume_usd: Math.round(event.volume ?? 0),
          source_url: event.slug ? `https://polymarket.com/event/${event.slug}` : 'https://polymarket.com',
        };
      });
    }, `polymarket:${q}`);
  },
  citation: (_, out) => ({ label: `Polymarket (${out.event_title})`, url: out.source_url }),
};
