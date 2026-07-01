import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';
import { getConfig } from '../config.js';

/**
 * AI Wealth Manager — companion API (read-only "market understanding").
 * Contract: C:\Users\Pc\Paul-Bot\PAUL_API.md. All routes under /api/paul/.
 *
 * This is Paul's analytical backbone: the current regime + prose market read
 * (ambient, pulled before every answer), plus deeper pulls on demand — strategy
 * postures, the cross-sectional long/short ranking, and per-coin directional
 * theses. It exposes *understanding*, never the underlying signal maths.
 *
 * Guardrail: Paul presents all of this as its OWN read (no source attribution),
 * and NEVER converts a "lean" or "basket" into a buy/sell call — it's context.
 */

// ---- Response shapes (loose — the API owns the schema) --------------------
export interface MarketRead {
  as_of?: string;
  headline?: string;
  market_read?: string;
  regime?: string;
  disclaimer?: string;
}
interface StrategiesResp {
  as_of?: string;
  strategies?: Array<{ name: string; posture: string; return_pct: number }>;
}
interface RankingResp {
  as_of?: string;
  strategy?: string;
  ranking?: Array<{
    rank: number;
    asset: string;
    standing: number;
    basket: string;
    trend?: { score: number; read: string };
    crowd_positioning?: { score: number; read: string };
    sentiment_news?: { score: number; read: string };
    volatility?: { score: number; read: string };
  }>;
}
interface DirectionalResp {
  strategy?: string;
  reads?: Array<{ asset: string; lean: string; read: string }>;
}

// ---- HTTP + caching -------------------------------------------------------
const cache = makeCache<unknown>(45_000); // 45s — the read updates on a slow cadence

async function companionGet<T>(path: string): Promise<T> {
  const cfg = getConfig();
  const key = cfg.PAUL_API_KEY;
  if (!key) throw new Error('PAUL_API_KEY not configured');
  return withRetry(async () => {
    return cache.wrap(path, async () => {
      const res = await fetchWithTimeout(
        `${cfg.PAUL_API_BASE_URL}${path}`,
        { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } },
        10_000,
      );
      if (!res.ok) throw new Error(`companion ${path} -> ${res.status}`);
      return res.json();
    }) as Promise<T>;
  }, `companion:${path}`);
}

export const fetchMarket = () => companionGet<MarketRead>('/api/paul/market');
const fetchStrategies = () => companionGet<StrategiesResp>('/api/paul/strategies');
const fetchRanking = () => companionGet<RankingResp>('/api/paul/ranking');
const fetchDirectional = () => companionGet<DirectionalResp>('/api/paul/directional');

/**
 * Compact market backdrop injected into every answer as ambient context.
 * Returns null on any failure so it can never block a reply.
 */
export async function marketBackdrop(): Promise<string | null> {
  try {
    const m = await fetchMarket();
    if (!m || (!m.regime && !m.market_read)) return null;
    const bits: string[] = [];
    if (m.regime) bits.push(`regime: ${m.regime}`);
    if (m.market_read) bits.push(m.market_read.trim());
    return bits.join(' — ');
  } catch {
    return null;
  }
}

// ---- On-demand tool -------------------------------------------------------
const InputSchema = z.object({
  section: z
    .enum(['market', 'strategies', 'ranking', 'directional'])
    .describe(
      'Which read to pull: "market" (regime + prose read), "strategies" (coarse posture + return per book), "ranking" (per-coin long/short standing on trend/positioning/sentiment/vol), "directional" (per-coin thesis vs levels/trend).',
    ),
  asset: z
    .string()
    .optional()
    .describe('Optional ticker to focus ranking/directional on a single coin (e.g. "BTC").'),
});
type Input = z.infer<typeof InputSchema>;

export const marketIntelTool: Tool<Input, unknown> = {
  name: 'market_intel',
  description:
    "Pull Paul's own deeper market understanding: current regime + read (section=market), live book postures (strategies), the cross-sectional per-coin long/short standing with a qualitative read on trend / crowd positioning / sentiment / volatility (ranking), or the per-coin directional thesis vs key levels (directional). Use it to ground a coin-specific take or to stress-test a user's thesis. Present it as YOUR read — never attribute it to a source, and never turn a 'lean' or 'basket' into a buy/sell call.",
  inputSchema: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        enum: ['market', 'strategies', 'ranking', 'directional'],
        description: 'Which read to pull.',
      },
      asset: { type: 'string', description: 'Optional ticker to focus ranking/directional (e.g. "BTC").' },
    },
    required: ['section'],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    const want = input.asset?.trim().toUpperCase().replace(/^\$/, '');
    switch (input.section) {
      case 'market':
        return fetchMarket();
      case 'strategies':
        return fetchStrategies();
      case 'ranking': {
        const r = await fetchRanking();
        if (want && r.ranking) {
          return { ...r, ranking: r.ranking.filter((x) => x.asset.toUpperCase() === want) };
        }
        return r;
      }
      case 'directional': {
        const d = await fetchDirectional();
        if (want && d.reads) {
          return { ...d, reads: d.reads.filter((x) => x.asset.toUpperCase() === want) };
        }
        return d;
      }
    }
  },
  citation: () => ({ label: 'Market intelligence' }),
};
