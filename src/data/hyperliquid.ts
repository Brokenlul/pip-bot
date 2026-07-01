import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';

/**
 * Hyperliquid public API — funding + open interest for perps.
 * This is the differentiator: it's what lets Paul say
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

async function fetchMeta(): Promise<{ universe: Array<{ name: string }> }> {
  const res = await fetchWithTimeout('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'meta' }),
  });
  if (!res.ok) throw new Error(`hyperliquid meta ${res.status}`);
  return res.json() as Promise<{ universe: Array<{ name: string }> }>;
}

async function fetchAssetCtxs(): Promise<Array<[unknown, AssetCtx]>> {
  // metaAndAssetCtxs returns [meta, ctxArray]; we want ctxArray
  const res = await fetchWithTimeout('https://api.hyperliquid.xyz/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
  });
  if (!res.ok) throw new Error(`hyperliquid ctxs ${res.status}`);
  const j = (await res.json()) as [unknown, AssetCtx[]];
  // Pair each ctx with its meta entry for naming
  const meta = (j[0] as { universe: Array<{ name: string }> }).universe;
  return j[1].map((ctx, i) => [meta[i], ctx] as [unknown, AssetCtx]);
}

export const fundingRateTool: Tool<Input, Output> = {
  name: 'crypto_perp_funding_and_oi',
  description:
    'Get the current perpetuals funding rate (hourly + annualized), mark price, and open interest for a crypto on Hyperliquid. Use for questions about "funding", "OI / open interest", "premium", or "what are perps doing on BTC/ETH/SOL". This is live derivatives data — prefer it over guessing.',
  inputSchema: {
    type: 'object',
    properties: {
      coin: {
        type: 'string',
        description: 'Perp ticker symbol (e.g. "BTC", "ETH", "SOL"). Uppercase, no $ prefix.',
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

      const ctxs = await fetchAssetCtxs();
      const found = ctxs.find(([meta]) => (meta as { name: string }).name.toUpperCase() === want);
      if (!found) {
        // Provide a hint about what universe is available
        const all = (await fetchMeta()).universe.map((u) => u.name).slice(0, 20).join(', ');
        throw new Error(`Coin "${want}" not found on Hyperliquid perps. Some available: ${all}`);
      }
      const [meta, ctx] = found;
      const fundingHourly = Number(ctx.funding);
      const out: Output = {
        coin: (meta as { name: string }).name,
        mark_price: Number(ctx.markPx),
        funding_rate_hourly: fundingHourly,
        funding_rate_annualized_pct: fundingHourly * 24 * 365 * 100,
        open_interest: Number(ctx.openInterest),
        premium: Number(ctx.premium ?? '0'),
        source_url: `https://app.hyperliquid.xyz/trade/${(meta as { name: string }).name}`,
      };
      cache.set(key, out);
      return out;
    }, `hyperliquid:${input.coin}`);
  },
  citation: (_, out) => ({ label: `Hyperliquid (${out.coin}-PERP)`, url: out.source_url }),
};
