import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';

/**
 * DexScreener public API — on-chain DEX pair data (price, liquidity, volume)
 * across every chain. Keyless. Use for long-tail / new tokens that CoinGecko
 * doesn't list yet, or when a contract address is provided.
 * Docs: https://docs.dexscreener.com/api/reference
 */

const InputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Token symbol, name, or contract address, e.g. "WIF", "pepe", or "0x..."'),
});
type Input = z.infer<typeof InputSchema>;

interface Output {
  symbol: string;
  name: string;
  chain: string;
  dex: string;
  price_usd: number;
  liquidity_usd: number;
  vol_24h_usd: number;
  change_24h_pct: number;
  fdv: number | null;
  market_cap: number | null;
  pair_address: string;
  matches: number;
  source_url: string;
}

interface DsPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  fdv?: number;
  marketCap?: number;
}

const cache = makeCache<Output>(45_000); // 45s — matches CLAUDE.md freshness target

export const dexScreenerTool: Tool<Input, Output> = {
  name: 'dex_token_lookup',
  description:
    'Look up on-chain DEX data (USD price, liquidity, 24h volume, 24h % change) for a token by symbol, name, or contract address across all chains via DexScreener. Use this for newer / smaller / memecoins or contract addresses that the crypto_price (CoinGecko) tool does not recognize. Returns the deepest-liquidity trading pair.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Token symbol, name, or contract address (e.g. "WIF", "pepe", "0xabc...").',
      },
    },
    required: ['query'],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    const q = input.query.trim();
    return withRetry(async () => {
      return cache.wrap(q.toLowerCase(), async () => {
        const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;
        const res = await fetchWithTimeout(url);
        if (!res.ok) throw new Error(`dexscreener search ${res.status}`);
        const data = (await res.json()) as { pairs?: DsPair[] };
        const pairs = data.pairs ?? [];
        if (pairs.length === 0) throw new Error(`No DEX pairs found for "${q}"`);
        // A name search on a popular ticker is thick with copycat/scam pairs —
        // some report huge nominal liquidity with near-zero real trading (a
        // seeded decoy pool, e.g. $76M liquidity / $0.01 24h volume), others
        // report leftover/stale volume against a pool that's since been
        // drained to ~$0 liquidity. Liquidity-only or volume-only tie-breaks
        // each fall for one of those. Require a liquidity floor first (a dead
        // pool doesn't get to win on stale volume), then rank the survivors by
        // volume — real trading activity is the harder signal to fake cheaply
        // and is what "most active/most popular" actually means.
        const MIN_LIQUIDITY_USD = 1000;
        const viable = pairs.filter((p) => (p.liquidity?.usd ?? 0) >= MIN_LIQUIDITY_USD);
        const pool = viable.length > 0 ? viable : pairs;
        const best = pool.slice().sort((a, b) => {
          const volDiff = (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0);
          return volDiff !== 0 ? volDiff : (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0);
        })[0]!;
        return {
          symbol: best.baseToken.symbol,
          name: best.baseToken.name,
          chain: best.chainId,
          dex: best.dexId,
          price_usd: Number(best.priceUsd ?? '0'),
          liquidity_usd: best.liquidity?.usd ?? 0,
          vol_24h_usd: best.volume?.h24 ?? 0,
          change_24h_pct: best.priceChange?.h24 ?? 0,
          fdv: best.fdv ?? null,
          market_cap: best.marketCap ?? null,
          pair_address: best.pairAddress,
          matches: pairs.length,
          source_url: best.url,
        };
      });
    }, `dexscreener:${q}`);
  },
  citation: (_, out) => ({
    label: `DexScreener (${out.symbol} · ${out.chain})`,
    url: out.source_url,
  }),
};
