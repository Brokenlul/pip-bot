import { getConfig } from '../config.js';
import { fetchWithTimeout, withRetry } from '../core/util.js';

/**
 * Zerion's dev tier rate-limits bursts, so a scan that fires resolve + charts +
 * two wallet reads at once gets intermittent 429s (silently nulling ATH / wallet
 * intel). Serialize every Zerion call through one queue with a min gap so we
 * stay well under the limit; 429/5xx are retried with backoff on top of that.
 */
const ZERION_MIN_GAP_MS = 250;
let zerionLastCall = 0;
let zerionTail: Promise<unknown> = Promise.resolve();
function scheduleZerion<T>(fn: () => Promise<T>): Promise<T> {
  const result = zerionTail.then(async () => {
    const wait = Math.max(0, zerionLastCall + ZERION_MIN_GAP_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    zerionLastCall = Date.now();
    return fn();
  });
  // Keep the chain alive even if this call rejects.
  zerionTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Zerion API client (api.zerion.io) — unified EVM + Solana wallet/token data.
 * Two jobs for token_scan:
 *   1. ATH / drawdown — fungible charts (`max` period = since launch).
 *   2. Deployer / whale wallet intel — is the deployer or a top holder
 *      distributing the token (dumping) vs accumulating.
 *
 * Auth is HTTP Basic with the API key as the username and an empty password.
 * All calls are best-effort: any failure returns null so a scan never breaks.
 */

// DexScreener chainId → Zerion chain_id slug. Extend as needed; a miss just
// means no Zerion enrichment for that chain (graceful).
const ZERION_CHAIN: Record<string, string> = {
  ethereum: 'ethereum',
  eth: 'ethereum',
  bsc: 'binance-smart-chain',
  binance: 'binance-smart-chain',
  bnb: 'binance-smart-chain',
  base: 'base',
  arbitrum: 'arbitrum',
  polygon: 'polygon',
  optimism: 'optimism',
  avalanche: 'avalanche',
  fantom: 'fantom',
  linea: 'linea',
  scroll: 'scroll',
  zksync: 'zksync-era',
  solana: 'solana',
};

export function zerionChain(dexChainId: string | null | undefined): string | null {
  if (!dexChainId) return null;
  return ZERION_CHAIN[dexChainId.toLowerCase()] ?? null;
}

export interface ZerionAth {
  ath_price: number;
  ath_date: string | null; // ISO
  ath_fdv: number | null; // derived: current FDV × (ath_price / current_price)
  drawdown_pct: number; // (current − ath) / ath × 100 — negative when below ATH
}

export interface ZerionWalletFlow {
  address: string; // shortened
  token_buys: number;
  token_sells: number;
  // net posture over the recent window for THIS token
  net: 'accumulating' | 'distributing' | 'flat';
  last_action_at: string | null; // ISO of most recent trade/transfer of the token
}

export interface ZerionIntel {
  ath: ZerionAth | null;
  deployer: ZerionWalletFlow | null;
  whale: ZerionWalletFlow | null;
}

function authHeader(): string {
  const key = getConfig().ZERION_API_KEY ?? '';
  // API key is the Basic-auth username; password is empty.
  const token = Buffer.from(`${key}:`).toString('base64');
  return `Basic ${token}`;
}

async function zerionGet<T = unknown>(path: string): Promise<T | null> {
  const url = `https://api.zerion.io${path}`;
  const label = path.split('?')[0];
  return withRetry(
    () =>
      scheduleZerion(async () => {
        const res = await fetchWithTimeout(
          url,
          { headers: { accept: 'application/json', authorization: authHeader() } },
          10_000,
        );
        // 404 = unknown token/wallet; 401/403 = key problem — none retryable → null.
        if (res.status === 404 || res.status === 401 || res.status === 403) return null;
        // 429 / 5xx throw so withRetry backs off and retries.
        if (!res.ok) throw new Error(`zerion ${res.status} ${label}`);
        return (await res.json()) as T;
      }),
    `zerion:${label}`,
  );
}

function shortWallet(w: string): string {
  return w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

// ---- Fungible resolution -------------------------------------------------

interface FungibleData {
  id: string;
  attributes?: {
    market_data?: {
      price?: number | null;
      market_cap?: number | null;
      fully_diluted_valuation?: number | null;
    };
  };
}

/** Resolve a chain+contract to Zerion's fungible id (needed for charts). */
async function resolveFungible(
  zChain: string,
  address: string,
): Promise<FungibleData | null> {
  const q = `filter[implementation_chain_id]=${encodeURIComponent(zChain)}&filter[implementation_address]=${encodeURIComponent(address)}`;
  const body = await zerionGet<{ data?: FungibleData[] }>(`/v1/fungibles/?${q}`);
  const first = body?.data?.[0];
  return first ?? null;
}

// ---- ATH / drawdown ------------------------------------------------------

interface ChartAttributes {
  // Zerion returns a stats summary plus the raw points. Parse both defensively.
  stats?: { first?: number; min?: number; avg?: number; max?: number; last?: number };
  points?: [number, number][]; // [unix_seconds, price]
  begin_at?: string;
  end_at?: string;
}

// ---- Wallet flow (deployer / whale distributing vs accumulating) ---------

interface TxTransfer {
  direction?: 'in' | 'out';
  fungible_info?: { implementations?: { address?: string | null }[] };
}
interface TxData {
  attributes?: {
    operation_type?: string; // 'trade' | 'send' | 'receive' | 'deploy' | ...
    mined_at?: string;
    transfers?: TxTransfer[];
  };
}

/**
 * A wallet's recent posture toward THIS token: buys vs sells over the last N
 * transactions involving the token. `filter[fungible_ids]` scopes it server-side
 * so we only pull relevant activity.
 */
async function fetchWalletFlow(
  address: string,
  fungibleId: string,
): Promise<ZerionWalletFlow | null> {
  // page[size] kept small: 50 makes Zerion's origin 504 on the fungible-filtered
  // query; 10 recent token txns is plenty to read accumulate-vs-distribute.
  const q = `filter[fungible_ids]=${encodeURIComponent(fungibleId)}&page[size]=10&currency=usd`;
  const body = await zerionGet<{ data?: TxData[] }>(
    `/v1/wallets/${encodeURIComponent(address)}/transactions/?${q}`,
  );
  const txs = body?.data;
  if (!txs || txs.length === 0) return null;

  let buys = 0;
  let sells = 0;
  let lastAt: string | null = null;
  for (const tx of txs) {
    const a = tx.attributes;
    if (!a) continue;
    if (lastAt == null && a.mined_at) lastAt = a.mined_at;
    const transfers = a.transfers ?? [];
    // Direction of the token in this tx: 'out' = leaving the wallet (sell/send),
    // 'in' = entering (buy/receive). A trade with the token going out is a sell.
    const out = transfers.some((t) => t.direction === 'out');
    const inn = transfers.some((t) => t.direction === 'in');
    const op = a.operation_type ?? '';
    if (op === 'trade') {
      if (out) sells += 1;
      else if (inn) buys += 1;
    } else if (op === 'send' && out) {
      sells += 1; // moving tokens out (often to a CEX to dump)
    } else if (op === 'receive' && inn) {
      buys += 1;
    }
  }

  const net: ZerionWalletFlow['net'] =
    sells > buys ? 'distributing' : buys > sells ? 'accumulating' : 'flat';
  return { address: shortWallet(address), token_buys: buys, token_sells: sells, net, last_action_at: lastAt };
}

// ---- Orchestration -------------------------------------------------------

/**
 * One-shot Zerion enrichment for token_scan. Resolves the fungible once, then
 * fans out ATH + up-to-two wallet-flow reads in parallel. All best-effort.
 * Bounded to ≤4 Zerion calls per scan (resolve, charts, deployer, whale).
 */
export async function fetchZerionIntel(
  dexChainId: string | null,
  address: string,
  opts: {
    currentPrice: number | null;
    currentFdv: number | null;
    deployerAddr?: string | null;
    whaleAddr?: string | null;
  },
): Promise<ZerionIntel> {
  const empty: ZerionIntel = { ath: null, deployer: null, whale: null };
  const zChain = zerionChain(dexChainId);
  if (!zChain) return empty;

  const fungible = await resolveFungible(zChain, address).catch(() => null);
  if (!fungible) return empty;

  const price = opts.currentPrice ?? fungible.attributes?.market_data?.price ?? null;
  const fdv = opts.currentFdv ?? fungible.attributes?.market_data?.fully_diluted_valuation ?? null;

  const [ath, deployer, whale] = await Promise.all([
    fetchAthFromFungible(fungible.id, price, fdv).catch(() => null),
    opts.deployerAddr
      ? fetchWalletFlow(opts.deployerAddr, fungible.id).catch(() => null)
      : Promise.resolve(null),
    opts.whaleAddr && opts.whaleAddr !== opts.deployerAddr
      ? fetchWalletFlow(opts.whaleAddr, fungible.id).catch(() => null)
      : Promise.resolve(null),
  ]);

  return { ath, deployer, whale };
}

/** Charts-only ATH given an already-resolved fungible id (avoids a 2nd resolve). */
async function fetchAthFromFungible(
  fungibleId: string,
  currentPriceUsd: number | null,
  currentFdv: number | null,
): Promise<ZerionAth | null> {
  const chart = await zerionGet<{ data?: { attributes?: ChartAttributes } }>(
    `/v1/fungibles/${encodeURIComponent(fungibleId)}/charts/max?currency=usd`,
  );
  const attrs = chart?.data?.attributes;
  if (!attrs) return null;
  const points = attrs.points ?? [];
  // Find the peak in the points (carrying its timestamp), then let stats.max
  // override the value if it is higher (the summary can beat the downsampled
  // series) — keeping the points-peak timestamp as the best date estimate.
  let athPrice: number | null = null;
  let athTs: number | null = null;
  for (const [ts, price] of points) {
    if (athPrice == null || price > athPrice) {
      athPrice = price;
      athTs = ts;
    }
  }
  const statsMax = attrs.stats?.max;
  if (statsMax != null && (athPrice == null || statsMax > athPrice)) athPrice = statsMax;
  if (athPrice == null || !Number.isFinite(athPrice) || athPrice <= 0) return null;
  const price = currentPriceUsd ?? attrs.stats?.last ?? null;
  const drawdown =
    price != null && price > 0 ? round2(((price - athPrice) / athPrice) * 100) : 0;
  const athFdv =
    currentFdv != null && price != null && price > 0
      ? Math.round(currentFdv * (athPrice / price))
      : null;
  return {
    ath_price: athPrice,
    ath_date: athTs != null ? new Date(athTs * 1000).toISOString() : null,
    ath_fdv: athFdv,
    drawdown_pct: drawdown,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
