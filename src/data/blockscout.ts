import { fetchWithTimeout } from '../core/util.js';

/**
 * Blockscout explorer fallback for EVM chains GoPlus doesn't index (e.g. new
 * app-chains like Robinhood Chain). Keyless public REST (`/api/v2/`). Gives the
 * holder count + top-holder concentration + contract-verification status so a
 * token on an unsupported chain stops returning security_available:false.
 *
 * Add a chain here by mapping its DexScreener chainId → Blockscout base host.
 */
const BLOCKSCOUT_HOST: Record<string, string> = {
  // Seeded with Robinhood Chain (the plan's fresh-launch example). Extend as
  // new app-chains show up that GoPlus lacks. Keyed by DexScreener chainId.
  robinhood: 'robinhoodchain.blockscout.com',
  robinhoodchain: 'robinhoodchain.blockscout.com',
};

export function blockscoutHost(dexChainId: string | null | undefined): string | null {
  if (!dexChainId) return null;
  return BLOCKSCOUT_HOST[dexChainId.toLowerCase()] ?? null;
}

export interface BlockscoutSecurity {
  chain_host: string;
  holders: number | null;
  top_holders_pct: number[]; // top-10 holder percentages (non-null)
  top10_concentration_pct: number | null;
  is_verified: boolean | null; // contract source verified on the explorer
  deployer: string | null; // creator address — feeds Zerion wallet intel
  top_holder: string | null; // largest non-contract holder — feeds Zerion whale intel
  name: string | null;
  symbol: string | null;
  explorer_url: string;
}

interface TokenInfo {
  holders?: string; // some instances: holder count as a string
  holders_count?: string;
  total_supply?: string;
  decimals?: string;
  name?: string;
  symbol?: string;
}
interface HolderItem {
  value?: string; // raw balance
  address?: { hash?: string; is_contract?: boolean };
}
interface AddressInfo {
  is_verified?: boolean;
  creator_address_hash?: string;
  name?: string;
}

async function bsGet<T>(host: string, path: string): Promise<T | null> {
  const url = `https://${host}/api/v2${path}`;
  const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, 10_000);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`blockscout ${res.status} ${path}`);
  return (await res.json()) as T;
}

/** Fetch holder-count + top-10 concentration + verification for an EVM token. */
export async function fetchBlockscoutSecurity(
  dexChainId: string,
  address: string,
): Promise<BlockscoutSecurity | null> {
  const host = blockscoutHost(dexChainId);
  if (!host) return null;

  const [token, holdersResp, addr] = await Promise.all([
    bsGet<TokenInfo>(host, `/tokens/${address}`).catch(() => null),
    bsGet<{ items?: HolderItem[] }>(host, `/tokens/${address}/holders`).catch(() => null),
    bsGet<AddressInfo>(host, `/addresses/${address}`).catch(() => null),
  ]);
  if (!token && !holdersResp) return null;

  const holderCount = num(token?.holders_count) ?? num(token?.holders);
  const totalSupply = num(token?.total_supply);

  // Percentages from raw balances / raw total supply (decimals cancel out).
  // Contracts (LP pools, the bonding-curve contract) are excluded from
  // concentration, same as the RugCheck/GoPlus pool exclusion.
  let topPcts: number[] = [];
  let concentration: number | null = null;
  let topHolder: string | null = null;
  if (holdersResp?.items?.length && totalSupply && totalSupply > 0) {
    const nonContract = holdersResp.items.filter((h) => !h.address?.is_contract);
    topHolder = nonContract[0]?.address?.hash ?? null;
    topPcts = nonContract
      .slice(0, 10)
      .map((h) => round2(((num(h.value) ?? 0) / totalSupply) * 100));
    concentration = topPcts.length ? round2(topPcts.reduce((s, p) => s + p, 0)) : null;
  }

  return {
    chain_host: host,
    holders: holderCount,
    top_holders_pct: topPcts,
    top10_concentration_pct: concentration,
    is_verified: addr?.is_verified ?? null,
    deployer: addr?.creator_address_hash ?? null,
    top_holder: topHolder,
    name: token?.name ?? addr?.name ?? null,
    symbol: token?.symbol ?? null,
    explorer_url: `https://${host}/token/${address}`,
  };
}

function num(v: string | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
