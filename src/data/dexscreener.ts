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
        // Pick the deepest-liquidity pair — most representative price.
        const best = pairs.reduce((a, b) =>
          (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a,
        );
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
