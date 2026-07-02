import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';

/**
 * DefiLlama — keyless crypto fundamentals: TVL, protocol fees/revenue,
 * stablecoin supply, DEX volume, chain metrics. This is the "flows &
 * fundamentals" lens: what capital is doing, not just price.
 * Plus the alternative.me crypto Fear & Greed index in the overview.
 * Docs: https://defillama.com/docs/api
 */

// ---- crypto_market_overview ----------------------------------------------

interface OverviewOut {
  total_defi_tvl_usd: number | null;
  top_chains: { chain: string; tvl_usd: number }[];
  stablecoin_total_usd: number | null;
  dex_volume_24h_usd: number | null;
  fees_24h_usd: number | null;
  fear_greed: { value: number; label: string } | null;
}

interface ChainTvl {
  name: string;
  tvl: number;
}
interface StablecoinsResp {
  peggedAssets?: Array<{ circulating?: { peggedUSD?: number } }>;
}
interface OverviewResp {
  total24h?: number;
}
interface FngResp {
  data?: Array<{ value?: string; value_classification?: string }>;
}

const overviewCache = makeCache<OverviewOut>(120_000); // 2 min

async function getJson<T>(url: string): Promise<T> {
  const res = await fetchWithTimeout(url, {}, 10_000);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json() as Promise<T>;
}

export const cryptoMarketOverviewTool: Tool<Record<string, never>, OverviewOut> = {
  name: 'crypto_market_overview',
  description:
    'A top-down snapshot of the crypto ecosystem: total DeFi TVL, the biggest chains by TVL, total stablecoin supply (a proxy for dry powder / capital on-ramp), 24h DEX volume, 24h protocol fees, and the crypto Fear & Greed index. Use for "how is DeFi / the market doing overall", risk-on/off reads, stablecoin supply trends, or to frame any answer with the broader backdrop.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  validate: () => ({}),
  execute: async () => {
    return withRetry(async () => {
      const hit = overviewCache.get('all');
      if (hit) return hit;
      const [chains, stables, dexs, fees, fng] = await Promise.all([
        getJson<ChainTvl[]>('https://api.llama.fi/v2/chains').catch(() => [] as ChainTvl[]),
        getJson<StablecoinsResp>('https://stablecoins.llama.fi/stablecoins?includePrices=false').catch(() => ({}) as StablecoinsResp),
        getJson<OverviewResp>('https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true').catch(() => ({}) as OverviewResp),
        getJson<OverviewResp>('https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true').catch(() => ({}) as OverviewResp),
        getJson<FngResp>('https://api.alternative.me/fng/?limit=1').catch(() => ({}) as FngResp),
      ]);

      const totalTvl = chains.length ? chains.reduce((s, c) => s + (c.tvl ?? 0), 0) : null;
      const topChains = [...chains]
        .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0))
        .slice(0, 6)
        .map((c) => ({ chain: c.name, tvl_usd: Math.round(c.tvl ?? 0) }));
      const stableTotal = stables.peggedAssets?.length
        ? stables.peggedAssets.reduce((s, a) => s + (a.circulating?.peggedUSD ?? 0), 0)
        : null;
      const fngEntry = fng.data?.[0];

      const out: OverviewOut = {
        total_defi_tvl_usd: totalTvl,
        top_chains: topChains,
        stablecoin_total_usd: stableTotal,
        dex_volume_24h_usd: dexs.total24h ?? null,
        fees_24h_usd: fees.total24h ?? null,
        fear_greed:
          fngEntry?.value != null
            ? { value: Number(fngEntry.value), label: fngEntry.value_classification ?? '' }
            : null,
      };
      overviewCache.set('all', out);
      return out;
    }, 'defillama:overview');
  },
  citation: () => ({ label: 'DefiLlama + Fear&Greed', url: 'https://defillama.com' }),
};

// ---- defi_protocol -------------------------------------------------------

const ProtocolSchema = z.object({
  name: z.string().min(1).describe('Protocol name or slug, e.g. "Aave", "Uniswap", "Hyperliquid".'),
});
type ProtocolInput = z.infer<typeof ProtocolSchema>;

interface ProtocolOut {
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number | null;
  change_1d_pct: number | null;
  change_7d_pct: number | null;
  mcap_usd: number | null;
  fees_24h_usd: number | null;
  revenue_24h_usd: number | null;
  url: string;
}

interface LlamaProtocol {
  name: string;
  slug: string;
  category?: string;
  chains?: string[];
  tvl?: number;
  change_1d?: number;
  change_7d?: number;
  mcap?: number;
}
interface FeesSummary {
  total24h?: number;
  totalDataChart?: unknown;
}

const protocolsCache = makeCache<LlamaProtocol[]>(300_000); // 5 min

async function allProtocols(): Promise<LlamaProtocol[]> {
  const hit = protocolsCache.get('all');
  if (hit) return hit;
  const data = await getJson<LlamaProtocol[]>('https://api.llama.fi/protocols');
  protocolsCache.set('all', data);
  return data;
}

export const defiProtocolTool: Tool<ProtocolInput, ProtocolOut> = {
  name: 'defi_protocol',
  description:
    "On-chain fundamentals for a specific DeFi protocol: total value locked (TVL), 1d/7d TVL change, category, chains, market cap, and 24h fees/revenue where available. Use for \"how much TVL does <protocol> have\", protocol health/traction, or fee/revenue (a protocol's actual business) questions.",
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Protocol name or slug (e.g. "Aave", "Uniswap").' } },
    required: ['name'],
  },
  validate: zValidator(ProtocolSchema),
  execute: async (input) => {
    const q = input.name.trim().toLowerCase();
    return withRetry(async () => {
      const list = await allProtocols();
      const match =
        list.find((p) => p.slug?.toLowerCase() === q || p.name?.toLowerCase() === q) ??
        list.find((p) => p.name?.toLowerCase().includes(q));
      if (!match) throw new Error(`No DefiLlama protocol matching "${input.name}"`);

      // Fees/revenue is a separate endpoint; best-effort, don't fail the read.
      const fees = await getJson<FeesSummary>(
        `https://api.llama.fi/summary/fees/${match.slug}?dataType=dailyRevenue`,
      ).catch(() => null);
      const feesGross = await getJson<FeesSummary>(
        `https://api.llama.fi/summary/fees/${match.slug}?dataType=dailyFees`,
      ).catch(() => null);

      return {
        name: match.name,
        category: match.category ?? null,
        chains: match.chains ?? [],
        tvl_usd: match.tvl ?? null,
        change_1d_pct: match.change_1d ?? null,
        change_7d_pct: match.change_7d ?? null,
        mcap_usd: match.mcap ?? null,
        fees_24h_usd: feesGross?.total24h ?? null,
        revenue_24h_usd: fees?.total24h ?? null,
        url: `https://defillama.com/protocol/${match.slug}`,
      };
    }, `defillama:protocol:${q}`);
  },
  citation: (_, out) => ({ label: `DefiLlama (${out.name})`, url: out.url }),
};
