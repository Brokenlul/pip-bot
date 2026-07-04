import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';
import { hlInfo } from './hyperliquid.js';

/**
 * Hyperliquid whale positions — live open positions of the venue's most
 * profitable leaderboard traders: entry price, direction, size, unrealized
 * PnL, leverage, liquidation. Answers "what are whales doing in X / what's
 * their entry and uPnL". Free public endpoints, no key.
 *
 * Pipeline: public leaderboard (candidate whales, ranked by recent realized
 * PnL) → clearinghouseState per wallet (ground truth — the leaderboard's own
 * accountValue field is often stale, so live state decides everything).
 * Standard perp universe only (HYPE, BTC, ETH, …) — builder-dex (HIP-3)
 * positions live in separate clearinghouses.
 */

const LEADERBOARD_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';

const InputSchema = z.object({
  coin: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional perp ticker to focus on (e.g. "HYPE", "BTC"). Omit for a cross-market view of what whales are holding.',
    ),
});
type Input = z.infer<typeof InputSchema>;

interface LeaderRow {
  ethAddress: string;
  accountValue: string;
  displayName?: string | null;
  windowPerformances?: Array<[string, { pnl: string; roi: string; vlm: string }]>;
}

interface RawPosition {
  coin: string;
  szi: string;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  leverage?: { value?: number };
  liquidationPx?: string | null;
}

interface ClearinghouseState {
  marginSummary?: { accountValue?: string };
  assetPositions?: Array<{ position: RawPosition }>;
}

interface WhalePosition {
  trader: string;
  coin: string;
  side: 'long' | 'short';
  size: number;
  notional_usd: number;
  entry_price: number;
  unrealized_pnl_usd: number;
  leverage_x: number | null;
  liquidation_price: number | null;
}

interface CoinBias {
  coin: string;
  longs: number;
  shorts: number;
  net_notional_usd: number;
}

interface Output {
  scope: string;
  whales_scanned: number;
  whales_with_position: number;
  longs: number;
  shorts: number;
  long_notional_usd: number;
  short_notional_usd: number;
  avg_entry_long: number | null;
  avg_entry_short: number | null;
  combined_unrealized_pnl_usd: number;
  top_positions: WhalePosition[];
  coin_bias?: CoinBias[];
  note: string;
  as_of: string;
  source_url: string;
}

interface Candidate {
  address: string;
  name?: string;
}

// The leaderboard payload is ~33 MB — fetch it rarely, keep only the trimmed
// candidate list. Final per-coin reads cache for a few minutes.
const candidateCache = makeCache<Candidate[]>(30 * 60_000);
const outputCache = makeCache<Output>(3 * 60_000);

function windowPnl(r: LeaderRow, win: string): number {
  const w = r.windowPerformances?.find((x) => x[0] === win);
  return w ? Number(w[1].pnl) : 0;
}

async function whaleCandidates(): Promise<Candidate[]> {
  return candidateCache.wrap('top', async () => {
    const res = await fetchWithTimeout(LEADERBOARD_URL, {}, 20_000);
    if (!res.ok) throw new Error(`hyperliquid leaderboard ${res.status}`);
    const j = (await res.json()) as { leaderboardRows?: LeaderRow[] };
    const rows = j.leaderboardRows ?? [];
    // Month-PnL leaders are the directional whales; week-PnL catches recent
    // risers. Raw accountValue is stale on this endpoint — don't rank by it.
    const pick = (win: string, n: number) =>
      rows.slice().sort((a, b) => windowPnl(b, win) - windowPnl(a, win)).slice(0, n);
    const seen = new Set<string>();
    const out: Candidate[] = [];
    for (const r of [...pick('month', 30), ...pick('week', 20)]) {
      const a = r.ethAddress?.toLowerCase();
      if (!a || seen.has(a)) continue;
      seen.add(a);
      out.push({ address: a, name: r.displayName || undefined });
    }
    if (out.length === 0) throw new Error('hyperliquid leaderboard returned no rows');
    return out;
  });
}

async function mapChunked<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const settled = await Promise.allSettled(items.slice(i, i + size).map(fn));
    for (const s of settled) if (s.status === 'fulfilled') out.push(s.value);
  }
  return out;
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

const usd = (n: number) => Math.round(n);

function toWhalePosition(c: Candidate, p: RawPosition): WhalePosition {
  const szi = Number(p.szi);
  return {
    trader: c.name ? `${c.name} (${shortAddr(c.address)})` : shortAddr(c.address),
    coin: p.coin,
    side: szi > 0 ? 'long' : 'short',
    size: Math.abs(szi),
    notional_usd: usd(Number(p.positionValue)),
    entry_price: Number(p.entryPx),
    unrealized_pnl_usd: usd(Number(p.unrealizedPnl)),
    leverage_x: p.leverage?.value ?? null,
    liquidation_price: p.liquidationPx != null ? Number(p.liquidationPx) : null,
  };
}

function weightedAvgEntry(ps: WhalePosition[]): number | null {
  const notional = ps.reduce((s, p) => s + p.notional_usd, 0);
  if (notional <= 0) return null;
  return ps.reduce((s, p) => s + p.entry_price * p.notional_usd, 0) / notional;
}

export const whalePositionsTool: Tool<Input, Output> = {
  name: 'hyperliquid_whale_positions',
  description:
    'Live open perp positions of the biggest / most profitable traders ("whales") on Hyperliquid — per-position entry price, direction, size, notional, unrealized PnL, leverage, and liquidation price, plus long/short totals and size-weighted average entries. Works for any standard Hyperliquid perp including HYPE, BTC, ETH, SOL. Use for "whale entries", "whale unrealized PnL / uPnL", "what are whales doing in X", "are whales long or short". Omit `coin` for a cross-market view of what whales hold. Whales = top realized-PnL traders from the public leaderboard — frame them as that, never as verified smart money or a signal to copy.',
  inputSchema: {
    type: 'object',
    properties: {
      coin: {
        type: 'string',
        description:
          'Optional perp ticker (e.g. "HYPE", "BTC"). Omit for a cross-market overview of whale positioning.',
      },
    },
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    return withRetry(
      async () => {
        const want = input.coin?.trim().toUpperCase().replace(/^\$/, '').replace(/-PERP$/, '');
        const key = `whales:${want ?? 'all'}`;
        const hit = outputCache.get(key);
        if (hit) return hit;

        const candidates = await whaleCandidates();
        const states = await mapChunked(candidates, 15, async (c) => ({
          c,
          s: await hlInfo<ClearinghouseState>({ type: 'clearinghouseState', user: c.address }),
        }));
        if (states.length === 0) throw new Error('could not read any whale account states');

        const all: WhalePosition[] = [];
        const holders = new Set<string>();
        for (const { c, s } of states) {
          for (const ap of s.assetPositions ?? []) {
            const p = ap.position;
            if (want && p.coin.toUpperCase() !== want) continue;
            if (Number(p.szi) === 0) continue;
            all.push(toWhalePosition(c, p));
            holders.add(c.address);
          }
        }

        const longs = all.filter((p) => p.side === 'long');
        const shorts = all.filter((p) => p.side === 'short');
        const top = all.slice().sort((a, b) => b.notional_usd - a.notional_usd).slice(0, 12);

        const out: Output = {
          scope: want ?? 'all standard Hyperliquid perps',
          whales_scanned: states.length,
          whales_with_position: holders.size,
          longs: longs.length,
          shorts: shorts.length,
          long_notional_usd: usd(longs.reduce((s, p) => s + p.notional_usd, 0)),
          short_notional_usd: usd(shorts.reduce((s, p) => s + p.notional_usd, 0)),
          avg_entry_long: want ? weightedAvgEntry(longs) : null,
          avg_entry_short: want ? weightedAvgEntry(shorts) : null,
          combined_unrealized_pnl_usd: usd(all.reduce((s, p) => s + p.unrealized_pnl_usd, 0)),
          top_positions: top,
          note: 'Whales = top realized-PnL traders from the public Hyperliquid leaderboard; live positions, standard perps only (builder-dex markets not included).',
          as_of: new Date().toISOString(),
          source_url: 'https://app.hyperliquid.xyz/leaderboard',
        };

        // Cross-market view: add the per-coin long/short bias table.
        if (!want) {
          const byCoin = new Map<string, CoinBias & { gross: number }>();
          for (const p of all) {
            const b = byCoin.get(p.coin) ?? { coin: p.coin, longs: 0, shorts: 0, net_notional_usd: 0, gross: 0 };
            if (p.side === 'long') {
              b.longs++;
              b.net_notional_usd += p.notional_usd;
            } else {
              b.shorts++;
              b.net_notional_usd -= p.notional_usd;
            }
            b.gross += p.notional_usd;
            byCoin.set(p.coin, b);
          }
          out.coin_bias = [...byCoin.values()]
            .sort((a, b) => b.gross - a.gross)
            .slice(0, 10)
            .map(({ gross: _g, ...b }) => ({ ...b, net_notional_usd: usd(b.net_notional_usd) }));
        }

        outputCache.set(key, out);
        return out;
      },
      `hl-whales:${input.coin ?? 'all'}`,
    );
  },
  citation: (input, _out) => ({
    label: `Hyperliquid whales${input.coin ? ` (${input.coin.toUpperCase()})` : ''}`,
    url: 'https://app.hyperliquid.xyz/leaderboard',
  }),
};
