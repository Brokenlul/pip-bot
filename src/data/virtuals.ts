import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';

/**
 * Virtuals Protocol launches — AI-agent token launches across chains
 * (Robinhood Chain, Base, Solana). Answers "what launched on Virtuals / on the
 * Robinhood chain lately", "biggest Virtuals agents", and identifies a pasted
 * Virtuals token by contract address. Keyless public API (api.virtuals.io).
 *
 * KEY INSIGHT (why web search failed here): a chain like ROBINHOOD has
 * thousands of `UNDERGRAD` prototypes — bonding-curve experiments with ~$8k
 * mcap and no token address. The real LAUNCHES are `status=AVAILABLE`:
 * graduated, live tokens with a contract. We filter to those so the list is
 * actual launches (Vimen, Fletcher, MONVERA…), not prototype noise.
 */

const API = 'https://api.virtuals.io/api/virtuals';

const CHAIN_MAP: Record<string, string> = {
  robinhood: 'ROBINHOOD', rh: 'ROBINHOOD', 'rh chain': 'ROBINHOOD', robinhoodchain: 'ROBINHOOD',
  base: 'BASE', solana: 'SOLANA', sol: 'SOLANA', ethereum: 'ETHEREUM', eth: 'ETHEREUM',
};

const Schema = z.object({
  chain: z.string().optional().describe('Chain filter: robinhood, base, or solana. Omit for all chains.'),
  query: z.string().optional().describe('Search by token name/symbol, or a 0x contract address to identify a specific token.'),
  sort: z.enum(['top', 'recent']).optional().describe('"top" = biggest by market cap (default); "recent" = newest launches.'),
  limit: z.number().int().min(1).max(25).optional(),
});
type Input = z.infer<typeof Schema>;

interface Launch {
  name: string;
  symbol: string;
  chain: string;
  token_address: string | null;
  mcap_usd: number | null;
  mcap_in_virtual: number | null;
  price_change_24h_pct: number | null;
  holders: number | null;
  launched_at: string | null;
  url: string;
}
interface Out {
  chain: string;
  sort: string;
  virtual_price_usd: number | null;
  count: number;
  launches: Launch[];
}

interface ApiAgent {
  id?: number;
  virtualId?: number;
  name?: string;
  symbol?: string;
  chain?: string;
  tokenAddress?: string;
  status?: string;
  mcapInVirtual?: number;
  priceChangePercent24h?: number;
  holderCount?: number;
  launchedAt?: string;
  lpCreatedAt?: string;
  createdAt?: string;
}
interface ApiResp {
  data?: ApiAgent[];
}

const cache = makeCache<Out>(120_000); // 2 min
const isAddress = (s: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(s.trim());

/** VIRTUAL/USD so we can report mcap in dollars (mcap comes denominated in VIRTUAL). */
async function virtualUsd(): Promise<number | null> {
  try {
    const res = await fetchWithTimeout(
      'https://api.coingecko.com/api/v3/simple/price?ids=virtual-protocol&vs_currencies=usd',
      {},
      8_000,
    );
    if (!res.ok) return null;
    const j = (await res.json()) as { 'virtual-protocol'?: { usd?: number } };
    return j['virtual-protocol']?.usd ?? null;
  } catch {
    return null;
  }
}

export const virtualsLaunchesTool: Tool<Input, Out> = {
  name: 'virtuals_launches',
  description:
    'List AI-agent token LAUNCHES on Virtuals Protocol across chains — including Robinhood Chain, Base, and Solana. Use this (NOT web search) whenever someone asks what has launched or is launching through Virtuals, the newest or biggest Virtuals agents on a chain (especially "Virtuals on Robinhood / RH chain"), or to identify a pasted Virtuals token by its contract address. Returns REAL graduated launches — name, symbol, contract, USD market cap, 24h change, holders, launch date — and deliberately filters out the thousands of tiny pre-launch prototypes so the list is actual launches, not noise. Web search cannot reliably enumerate these and WILL undercount (it will make you say "only X launched" when there are many); always prefer this tool for "what launched on Virtuals" questions. Pass chain=robinhood for the RH-chain question, sort=recent for newest, sort=top for biggest.',
  inputSchema: {
    type: 'object',
    properties: {
      chain: { type: 'string', description: 'Chain: robinhood, base, or solana. Omit for all chains.' },
      query: { type: 'string', description: 'Search by name/symbol, or a 0x contract address to identify a specific token.' },
      sort: { type: 'string', enum: ['top', 'recent'], description: '"top" = biggest by market cap (default); "recent" = newest launches.' },
      limit: { type: 'integer', description: 'How many to return (default 12, max 25).' },
    },
    required: [],
  },
  validate: zValidator(Schema),
  execute: async (input) => {
    const chainKey = input.chain?.trim().toLowerCase();
    const chain = chainKey ? (CHAIN_MAP[chainKey] ?? chainKey.toUpperCase()) : '';
    const sort = input.sort ?? 'top';
    const limit = input.limit ?? 12;
    const q = input.query?.trim();
    const cacheKey = `${chain}|${sort}|${limit}|${q ?? ''}`;

    return withRetry(async () => {
      const hit = cache.get(cacheKey);
      if (hit) return hit;

      // Fetch a little extra so client-side filtering still yields `limit`.
      const fetchSize = Math.min(limit + 8, 50);
      const params = new URLSearchParams();
      params.set('pagination[pageSize]', String(fetchSize));
      params.set('pagination[page]', '1');
      if (chain) params.set('filters[chain]', chain);
      if (q) {
        if (isAddress(q)) params.set('filters[tokenAddress]', q);
        else params.set('filters[name][$containsi]', q);
      }
      // The API ignores status filters, so a real LAUNCH = has a token address
      // (graduated off the bonding curve). The sort surfaces them: market cap for
      // "top", LP-creation date for "recent" (only graduated tokens have an LP).
      params.set('sort[0]', sort === 'recent' ? 'lpCreatedAt:desc' : 'mcapInVirtual:desc');

      const res = await fetchWithTimeout(`${API}?${params.toString()}`, { headers: { accept: 'application/json' } }, 12_000);
      if (!res.ok) throw new Error(`virtuals ${res.status}`);
      const json = (await res.json()) as ApiResp;
      const rows = (json.data ?? []).filter((a) => a.tokenAddress); // graduated launches only

      const vUsd = await virtualUsd();
      const launches: Launch[] = rows.slice(0, limit).map((a) => ({
        name: a.name ?? '?',
        symbol: a.symbol ?? '?',
        chain: a.chain ?? chain ?? '?',
        token_address: a.tokenAddress ?? null,
        mcap_in_virtual: a.mcapInVirtual ?? null,
        mcap_usd: a.mcapInVirtual != null && vUsd != null ? Math.round(a.mcapInVirtual * vUsd) : null,
        price_change_24h_pct: a.priceChangePercent24h ?? null,
        holders: a.holderCount ?? null,
        launched_at: (a.launchedAt ?? a.lpCreatedAt ?? a.createdAt ?? '').slice(0, 10) || null,
        url: `https://app.virtuals.io/virtuals/${a.virtualId ?? a.id ?? ''}`,
      }));

      const out: Out = { chain: chain || 'all', sort, virtual_price_usd: vUsd, count: launches.length, launches };
      cache.set(cacheKey, out);
      return out;
    }, `virtuals:${cacheKey}`);
  },
  citation: (input) => ({
    label: `Virtuals Protocol${input.chain ? ` (${input.chain})` : ''}`,
    url: 'https://app.virtuals.io',
  }),
};
