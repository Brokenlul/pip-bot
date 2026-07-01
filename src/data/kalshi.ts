import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry } from '../core/util.js';

/**
 * Kalshi — CFTC-regulated US prediction markets. Keyless for read access.
 * Kalshi has NO free-text search endpoint; it is organized by *series ticker*
 * (e.g. KXRATECUT = Fed rate cut, KXACPICORE = core inflation, BTC = Bitcoin range).
 * So we map the query to a series ticker via (1) a curated alias table for the
 * high-value macro/crypto topics, then (2) a fuzzy match over the cached series
 * catalog. Then we pull that series' nearest open markets and their Yes odds.
 * Docs: https://trading-api.readme.io/reference/getting-started
 */

const API = 'https://api.elections.kalshi.com/trade-api/v2';
const CATALOG_CATEGORIES = ['Economics', 'Crypto', 'Financials'] as const;

// High-value shortcuts so common macro/crypto asks resolve instantly & correctly.
const SERIES_ALIASES: Record<string, string> = {
  'fed rate cut': 'KXRATECUT',
  'rate cut': 'KXRATECUT',
  'fed cut': 'KXRATECUT',
  'fed decision': 'KXRATECUT',
  cpi: 'KXACPICORE',
  'core cpi': 'KXACPICORE',
  'core inflation': 'KXACPICORE',
  inflation: 'KXACPICORE',
  recession: 'KXRECSSNBER',
  'us recession': 'KXRECSSNBER',
  bitcoin: 'BTC',
  btc: 'BTC',
  'bitcoin range': 'BTC',
  ethereum: 'ETHD',
  eth: 'ETHD',
};

const InputSchema = z.object({
  query: z.string().min(1).describe('Topic to find Kalshi markets for, e.g. "Fed rate cut", "CPI", "US recession", "BTC".'),
});
type Input = z.infer<typeof InputSchema>;

interface OutcomeOdds {
  label: string;
  yes_probability_pct: number;
  closes_utc: string;
}

interface Output {
  series_ticker: string;
  event_title: string;
  outcomes: OutcomeOdds[];
  source_url: string;
}

interface KalshiSeries {
  ticker: string;
  title?: string;
}
interface KalshiMarket {
  ticker: string;
  title?: string;
  yes_sub_title?: string;
  status?: string;
  close_time?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  volume_fp?: string;
}
interface KalshiEvent {
  event_ticker: string;
  title?: string;
  sub_title?: string;
  markets?: KalshiMarket[];
}

const eventCache = makeCache<Output>(60_000); // 60s
const catalogCache = makeCache<KalshiSeries[]>(6 * 60 * 60_000); // 6h — catalog is stable

async function fetchCatalog(): Promise<KalshiSeries[]> {
  return catalogCache.wrap('catalog', async () => {
    const all: KalshiSeries[] = [];
    for (const cat of CATALOG_CATEGORIES) {
      const res = await fetch(`${API}/series?category=${cat}`);
      if (!res.ok) continue; // best-effort: a bad category shouldn't kill the lookup
      const j = (await res.json()) as { series?: KalshiSeries[] };
      all.push(...(j.series ?? []));
    }
    return all;
  });
}

/** Token-overlap score of query against a series title/ticker. */
function scoreSeries(query: string, s: KalshiSeries): number {
  const hay = `${s.title ?? ''} ${s.ticker}`.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return 0;
  return tokens.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
}

/** Ordered candidate series tickers: alias first, then best fuzzy catalog matches. */
async function resolveSeriesCandidates(query: string): Promise<string[]> {
  const key = query.trim().toLowerCase();
  const out: string[] = [];
  if (SERIES_ALIASES[key]) out.push(SERIES_ALIASES[key]!);
  const catalog = await fetchCatalog();
  const scored = catalog
    .map((s) => ({ ticker: s.ticker, score: scoreSeries(query, s) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  for (const s of scored) if (!out.includes(s.ticker)) out.push(s.ticker);
  if (out.length === 0) throw new Error(`No Kalshi series matched "${query}"`);
  return out.slice(0, 6);
}

async function fetchOpenMarkets(seriesTicker: string): Promise<Array<{ e: KalshiEvent; m: KalshiMarket }>> {
  const res = await fetch(`${API}/events?series_ticker=${encodeURIComponent(seriesTicker)}&with_nested_markets=true`);
  if (!res.ok) throw new Error(`kalshi events ${res.status}`);
  const j = (await res.json()) as { events?: KalshiEvent[] };
  return (j.events ?? []).flatMap((e) =>
    (e.markets ?? [])
      .filter((m) => m.status === 'active' && m.close_time)
      .map((m) => ({ e, m })),
  );
}

function yesProbability(m: KalshiMarket): number {
  const bid = Number(m.yes_bid_dollars ?? '0');
  const ask = Number(m.yes_ask_dollars ?? '0');
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask;
  const p = mid > 0 ? mid : Number(m.last_price_dollars ?? '0');
  return Math.round(p * 1000) / 10;
}

export const kalshiTool: Tool<Input, Output> = {
  name: 'prediction_market_kalshi',
  description:
    'Get current Kalshi (CFTC-regulated US prediction market) odds for a macro/crypto topic. Best for Fed rate decisions, CPI/inflation, recession odds, and BTC/ETH ranges. Use alongside or instead of Polymarket for a second market-implied probability. Returns the nearest open markets and their Yes probabilities.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Topic (e.g. "Fed rate cut", "CPI", "US recession", "BTC range").',
      },
    },
    required: ['query'],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    const q = input.query.trim();
    return withRetry(async () => {
      return eventCache.wrap(q.toLowerCase(), async () => {
        const candidates = await resolveSeriesCandidates(q);
        // Try candidates in order; skip any series with no open markets (stale catalog entries).
        let seriesTicker = '';
        let rows: Array<{ e: KalshiEvent; m: KalshiMarket }> = [];
        for (const t of candidates) {
          const found = await fetchOpenMarkets(t);
          if (found.length > 0) {
            seriesTicker = t;
            rows = found;
            break;
          }
        }
        if (rows.length === 0) throw new Error(`No open Kalshi markets for "${q}"`);
        // Nearest-closing first.
        rows.sort((a, b) => new Date(a.m.close_time!).getTime() - new Date(b.m.close_time!).getTime());

        const top = rows.slice(0, 6);
        const eventTitle = top[0]!.e.title ?? seriesTicker;
        const outcomes: OutcomeOdds[] = top.map(({ m }) => ({
          label: m.yes_sub_title || m.title || m.ticker,
          yes_probability_pct: yesProbability(m),
          closes_utc: m.close_time!,
        }));

        return {
          series_ticker: seriesTicker,
          event_title: eventTitle,
          outcomes,
          source_url: `https://kalshi.com/markets/${seriesTicker.toLowerCase()}`,
        };
      });
    }, `kalshi:${q}`);
  },
  citation: (_, out) => ({ label: `Kalshi (${out.event_title})`, url: out.source_url }),
};
