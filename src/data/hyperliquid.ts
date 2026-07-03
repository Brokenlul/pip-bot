import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';

/**
 * Hyperliquid public API — funding + open interest for perps.
 * This is the differentiator: it's what lets Pip say
 * "funding flipped negative across BTC perps", which a vanilla LLM can't.
 *
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 */

const InputSchema = z.object({
  coin: z
    .string()
    .min(1)
    .describe('Perp coin ticker on Hyperliquid (e.g. "BTC", "ETH", "SOL"). No "$" or "/USDT".'),
});
type Input = z.infer<typeof InputSchema>;

interface Output {
  coin: string;
  mark_price: number;
  funding_rate_hourly: number;
  funding_rate_annualized_pct: number;
  open_interest: number;
  premium: number;
  source_url: string;
}

const cache = makeCache<Output>(30_000); // 30s

interface AssetCtx {
  coin: string;
  markPx: string;
  openInterest: string;
  funding: string;
  premium?: string;
}

interface UniverseEntry {
  name: string;
}

async function hlInfo<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetchWithTimeout('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`hyperliquid ${body.type} ${res.status}`);
  return res.json() as Promise<T>;
}

async function fetchMeta(): Promise<{ universe: UniverseEntry[] }> {
  return hlInfo<{ universe: UniverseEntry[] }>({ type: 'meta' });
}

async function fetchAssetCtxs(): Promise<Array<[UniverseEntry, AssetCtx]>> {
  // metaAndAssetCtxs returns [meta, ctxArray]; pair each ctx with its meta entry.
  const j = await hlInfo<[{ universe: UniverseEntry[] }, AssetCtx[]]>({ type: 'metaAndAssetCtxs' });
  const meta = j[0].universe;
  return j[1].map((ctx, i) => [meta[i], ctx] as [UniverseEntry, AssetCtx]);
}

// ---- Builder-deployed (HIP-3) markets ------------------------------------
// Builder DEXs (e.g. `xyz` tokenized equities, `vntl` thematic baskets) live
// outside the default perp universe. Coin names there are dex-prefixed, e.g.
// "xyz:BOT", "vntl:ROBOT". We scan them only when a ticker misses the default
// universe, and cache the flattened table so the scan happens at most ~1/min.

interface BuilderMarket {
  dex: string;
  name: string; // dex-prefixed, e.g. "xyz:BOT"
  ctx: AssetCtx;
}
const builderCache = makeCache<BuilderMarket[]>(60_000);

async function fetchPerpDexNames(): Promise<string[]> {
  const arr = await hlInfo<Array<{ name?: string } | null>>({ type: 'perpDexs' });
  return arr.filter((d): d is { name: string } => Boolean(d && d.name)).map((d) => d.name);
}

async function allBuilderMarkets(): Promise<BuilderMarket[]> {
  const hit = builderCache.get('all');
  if (hit) return hit;
  const dexes = await fetchPerpDexNames();
  const perDex = await Promise.all(
    dexes.map((dex) =>
      hlInfo<[{ universe: UniverseEntry[] }, AssetCtx[]]>({ type: 'metaAndAssetCtxs', dex })
        .then(([m, ctxs]) => ctxs.map((ctx, i) => ({ dex, name: m.universe[i]?.name ?? '', ctx })))
        .catch(() => [] as BuilderMarket[]),
    ),
  );
  const flat = perDex.flat().filter((b) => b.name);
  builderCache.set('all', flat);
  return flat;
}

/** Find a builder market by exact "dex:TICKER" or by bare TICKER (highest-OI wins). */
function matchBuilderMarket(markets: BuilderMarket[], want: string): BuilderMarket | undefined {
  const matches = markets.filter((b) => {
    const n = b.name.toUpperCase();
    return n === want || n.split(':').pop() === want;
  });
  if (matches.length === 0) return undefined;
  return matches.reduce((a, b) => (Number(b.ctx.openInterest) > Number(a.ctx.openInterest) ? b : a));
}

function toOutput(name: string, ctx: AssetCtx): Output {
  const fundingHourly = Number(ctx.funding);
  return {
    coin: name,
    mark_price: Number(ctx.markPx),
    funding_rate_hourly: fundingHourly,
    funding_rate_annualized_pct: fundingHourly * 24 * 365 * 100,
    open_interest: Number(ctx.openInterest),
    premium: Number(ctx.premium ?? '0'),
    source_url: `https://app.hyperliquid.xyz/trade/${name}`,
  };
}

export const fundingRateTool: Tool<Input, Output> = {
  name: 'crypto_perp_funding_and_oi',
  description:
    'Get the current perpetuals funding rate (hourly + annualized), mark price, and open interest for a market on Hyperliquid. Covers the standard perp universe (BTC, ETH, SOL, …) AND builder-deployed (HIP-3) markets — tokenized equities and thematic baskets on venues like `xyz` (e.g. BOT, TSLA, NVDA, HOOD) and `vntl` (e.g. ROBOT, OPENAI, DEFENSE). Use for "funding", "OI / open interest", "premium", "what is <ticker> on Hyperliquid", or "what are perps doing on X". Pass just the ticker (e.g. "BOT") — it auto-resolves the builder DEX — or the full "dex:TICKER" if you know it. Live derivatives data; prefer it over guessing.',
  inputSchema: {
    type: 'object',
    properties: {
      coin: {
        type: 'string',
        description:
          'Ticker symbol (e.g. "BTC", "SOL", "BOT", "TSLA"). No $ prefix. Optionally "dex:TICKER" like "xyz:BOT" for a specific builder market.',
      },
    },
    required: ['coin'],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    return withRetry(async () => {
      const want = input.coin.trim().toUpperCase().replace(/^\$/, '');
      const key = `hl:${want}`;
      const hit = cache.get(key);
      if (hit) return hit;

      // 1. Standard perp universe.
      const ctxs = await fetchAssetCtxs();
      const found = ctxs.find(([meta]) => meta.name.toUpperCase() === want);
      if (found) {
        const out = toOutput(found[0].name, found[1]);
        cache.set(key, out);
        return out;
      }

      // 2. Builder-deployed (HIP-3) markets — tokenized equities / baskets.
      const builder = matchBuilderMarket(await allBuilderMarkets(), want);
      if (builder) {
        const out = toOutput(builder.name, builder.ctx);
        cache.set(key, out);
        return out;
      }

      const all = (await fetchMeta()).universe.map((u) => u.name).slice(0, 20).join(', ');
      throw new Error(
        `Coin "${want}" not found on Hyperliquid (standard perps or builder markets). Some standard: ${all}`,
      );
    }, `hyperliquid:${input.coin}`);
  },
  citation: (_, out) => ({ label: `Hyperliquid (${out.coin}-PERP)`, url: out.source_url }),
};
