import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';
import { getConfig } from '../config.js';

const InputSchema = z.object({
  asset: z.string().min(1).describe('Crypto asset symbol or name, e.g. "BTC", "ETH", "solana".'),
});
type Input = z.infer<typeof InputSchema>;

interface Output {
  symbol: string;
  name: string;
  price_usd: number;
  market_cap_usd: number;
  vol_24h_usd: number;
  change_24h_pct: number;
  source_url: string;
}

const cache = makeCache<Output>(45_000); // 45s — matches the 30–60s target in CLAUDE.md
const idCache = makeCache<string | null>(60 * 60_000); // 1h asset-id resolution

const SYMBOL_OVERRIDES: Record<string, string> = {
  btc: 'bitcoin',
  eth: 'ethereum',
  sol: 'solana',
  doge: 'dogecoin',
  xrp: 'ripple',
  bnb: 'binancecoin',
  ada: 'cardano',
  avax: 'avalanche-2',
  matic: 'matic-network',
  link: 'chainlink',
  uni: 'uniswap',
  ltc: 'litecoin',
};

function baseHeaders(): Record<string, string> {
  const key = getConfig().COINGECKO_API_KEY;
  return key ? { 'x-cg-demo-api-key': key } : {};
}

async function resolveCoinId(query: string): Promise<string | null> {
  const q = query.trim().toLowerCase();
  return idCache.wrap(q, async () => {
    if (SYMBOL_OVERRIDES[q]) return SYMBOL_OVERRIDES[q]!;
    const url = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`;
    const res = await fetchWithTimeout(url, { headers: baseHeaders() });
    if (!res.ok) throw new Error(`coingecko search ${res.status}`);
    const data = (await res.json()) as { coins?: Array<{ id: string; symbol: string; name: string }> };
    const exact = data.coins?.find(
      (c) => c.symbol.toLowerCase() === q || c.name.toLowerCase() === q,
    );
    return (exact ?? data.coins?.[0])?.id ?? null;
  });
}

async function fetchPrice(coinId: string): Promise<Output> {
  return cache.wrap(coinId, async () => {
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`;
    const res = await fetchWithTimeout(url, { headers: baseHeaders() });
    if (!res.ok) throw new Error(`coingecko price ${res.status}`);
    const j = (await res.json()) as {
      symbol: string;
      name: string;
      market_data: {
        current_price: { usd: number };
        market_cap: { usd: number };
        total_volume: { usd: number };
        price_change_percentage_24h: number;
      };
    };
    return {
      symbol: j.symbol.toUpperCase(),
      name: j.name,
      price_usd: j.market_data.current_price.usd,
      market_cap_usd: j.market_data.market_cap.usd,
      vol_24h_usd: j.market_data.total_volume.usd,
      change_24h_pct: j.market_data.price_change_percentage_24h,
      source_url: `https://www.coingecko.com/en/coins/${coinId}`,
    };
  });
}

export const cryptoPriceTool: Tool<Input, Output> = {
  name: 'crypto_price',
  description:
    'Get the current USD price, market cap, 24h volume, and 24h % change for a crypto asset. Use this for spot price questions like "what is BTC at" or "ETH price".',
  inputSchema: {
    type: 'object',
    properties: {
      asset: {
        type: 'string',
        description: 'Asset symbol or name (e.g. "BTC", "ethereum", "SOL").',
      },
    },
    required: ['asset'],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    return withRetry(async () => {
      const id = await resolveCoinId(input.asset);
      if (!id) throw new Error(`Unknown asset: ${input.asset}`);
      return fetchPrice(id);
    }, `coingecko:${input.asset}`);
  },
  citation: (_, out) => ({ label: `CoinGecko (${out.symbol})`, url: out.source_url }),
};
