import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';
import { getConfig, solanaTrackerEnabled } from '../config.js';

/**
 * Memecoin / degen "scan" tool — a Rick-style read on a contract address.
 * Fuses two keyless sources:
 *   - DexScreener  → market data (price, FDV, liquidity, volume, age, txns, socials)
 *   - RugCheck     → on-chain security (Solana only): top-holder concentration,
 *                    insider flags, LP locked %, mint/freeze authority, risk flags.
 *
 * Solana mints get the full scan. EVM (0x…) addresses get DexScreener market
 * data only, with security_available=false.
 * POST-MVP: EVM security via GoPlus; smart-money / fresh-wallet labels via a
 * labeled-wallet DB (Nansen/Arkham/GMGN) — not sourced here, don't fabricate.
 */

// Accept only a real Solana base58 mint (32–44 chars, no 0/O/I/l) or an EVM
// 0x address. This keeps junk / injection strings out of the outbound API URLs
// (DexScreener, RugCheck, GoPlus) instead of relaying whatever the model passes.
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const InputSchema = z.object({
  address: z
    .string()
    .trim()
    .refine((a) => EVM_ADDR_RE.test(a) || SOL_ADDR_RE.test(a), {
      message: 'Not a valid contract address (expected an EVM 0x… address or a Solana base58 mint).',
    })
    .describe('Token contract address / mint (Solana base58 or EVM 0x…).'),
});
type Input = z.infer<typeof InputSchema>;

interface TopHolder {
  pct: number;
  insider: boolean;
  label?: string; // known-account name (e.g. AMM, exchange) when RugCheck knows it
  is_pool: boolean; // AMM / LP / market account — excluded from concentration
}

interface Output {
  address: string;
  chain: string;
  symbol: string | null;
  name: string | null;
  // Market (DexScreener)
  price_usd: number | null;
  fdv: number | null;
  market_cap: number | null;
  liquidity_usd: number | null;
  vol_24h_usd: number | null;
  change_24h_pct: number | null;
  txns_24h: { buys: number; sells: number } | null;
  age_hours: number | null;
  socials: string[];
  dex_url: string | null;
  // Security — chain-agnostic (RugCheck for Solana, GoPlus for EVM)
  security_available: boolean;
  holders: number | null;
  top_holders: TopHolder[]; // top 10, non-pool
  top10_concentration_pct: number | null; // sum of top-10 non-pool holders
  lp_locked_pct: number | null;
  risks: { name: string; level: string; description: string }[]; // danger/warn/info flags
  // Solana-only (RugCheck) — null on EVM
  insider_held_pct: number | null; // sum of top-holder pct flagged insider
  insiders_detected: number | null; // network-wide insider wallets (graph)
  mint_authority_renounced: boolean | null;
  freeze_authority_renounced: boolean | null;
  metadata_mutable: boolean | null;
  rugged: boolean | null;
  risk_score: number | null; // RugCheck normalised — lower is safer
  launchpad: string | null;
  rugcheck_url: string | null;
  // EVM-only (GoPlus) — null on Solana
  evm_security: EvmSecurity | null;
  // Smart-money proxy (Solana Tracker — only when SOLANA_TRACKER_API_KEY set)
  smart_money: SmartMoney | null;
}

interface EvmSecurity {
  chain_id: string;
  is_honeypot: boolean | null;
  buy_tax_pct: number | null;
  sell_tax_pct: number | null;
  cannot_sell_all: boolean | null;
  is_open_source: boolean | null;
  is_proxy: boolean | null;
  is_mintable: boolean | null;
  ownership_renounced: boolean | null; // owner is zero/dead address
  owner_percent: number | null;
  creator_percent: number | null;
  can_take_back_ownership: boolean | null;
  hidden_owner: boolean | null;
  transfer_pausable: boolean | null;
  is_blacklisted: boolean | null;
  trading_cooldown: boolean | null;
  goplus_url: string;
}

interface SmartMoneyTrader {
  wallet: string; // shortened
  realized_pnl_usd: number | null;
  total_pnl_usd: number | null;
  win_rate_pct: number | null;
  still_holding: boolean | null;
}
interface SmartMoney {
  trader_count: number; // profitable traders returned for this token
  still_holding: number; // how many still hold a position
  exited: number; // how many fully exited
  cohort_realized_pnl_usd: number; // sum of realized PnL across the cohort
  top: SmartMoneyTrader[]; // top 5 by total PnL
}

// ---- DexScreener ---------------------------------------------------------

interface DsPair {
  chainId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken?: { address: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number; // ms epoch
  info?: { socials?: { url?: string }[]; websites?: { url?: string }[] };
}

async function fetchDex(address: string): Promise<DsPair | null> {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`dexscreener tokens ${res.status}`);
  const data = (await res.json()) as { pairs?: DsPair[] };
  const all = data.pairs ?? [];
  if (all.length === 0) return null;
  // Prefer pairs where our token is the base; fall back to any.
  const lower = address.toLowerCase();
  const base = all.filter((p) => p.baseToken.address.toLowerCase() === lower);
  const pool = base.length ? base : all;
  return pool.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
}

// ---- RugCheck (Solana) ---------------------------------------------------

interface RcHolder {
  address: string;
  owner: string;
  pct: number;
  insider?: boolean;
}
interface RcReport {
  tokenMeta?: { name?: string; symbol?: string; mutable?: boolean };
  topHolders?: RcHolder[];
  freezeAuthority?: string | null;
  mintAuthority?: string | null;
  risks?: { name: string; level: string; description: string }[];
  score_normalised?: number;
  totalHolders?: number;
  rugged?: boolean;
  graphInsidersDetected?: number;
  knownAccounts?: Record<string, { name?: string; type?: string }>;
  markets?: { lp?: { lpLockedPct?: number; baseUSD?: number; quoteUSD?: number } }[];
  deployPlatform?: string;
  // RugCheck returns this as a rich object ({ name, platform, … }) for
  // pump.fun-style tokens and a bare string for others — handle both.
  launchpad?: string | { name?: string; platform?: string } | null;
}

const POOL_TYPE = /amm|pool|market|lp|liquidity/i;

async function fetchRugcheck(mint: string): Promise<RcReport | null> {
  const url = `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(mint)}/report`;
  const res = await fetchWithTimeout(url, {}, 12_000);
  if (res.status === 404 || res.status === 400) return null; // not a Solana mint RugCheck knows
  if (!res.ok) throw new Error(`rugcheck ${res.status}`);
  return (await res.json()) as RcReport;
}

function primaryLpLockedPct(rc: RcReport): number | null {
  const markets = rc.markets ?? [];
  if (!markets.length) return null;
  const best = markets.reduce((a, b) => {
    const av = (a.lp?.baseUSD ?? 0) + (a.lp?.quoteUSD ?? 0);
    const bv = (b.lp?.baseUSD ?? 0) + (b.lp?.quoteUSD ?? 0);
    return bv > av ? b : a;
  });
  return best.lp?.lpLockedPct ?? null;
}

function mapTopHolders(rc: RcReport): {
  top: TopHolder[];
  concentration: number;
  insiderPct: number;
} {
  const known = rc.knownAccounts ?? {};
  const holders = rc.topHolders ?? [];
  const mapped: TopHolder[] = holders.map((h) => {
    const meta = known[h.address] ?? known[h.owner];
    const isPool = meta ? POOL_TYPE.test(meta.type ?? '') : false;
    return { pct: h.pct, insider: Boolean(h.insider), label: meta?.name, is_pool: isPool };
  });
  const nonPool = mapped.filter((h) => !h.is_pool);
  const concentration = nonPool.slice(0, 10).reduce((s, h) => s + h.pct, 0);
  const insiderPct = mapped.filter((h) => h.insider).reduce((s, h) => s + h.pct, 0);
  return { top: nonPool.slice(0, 10), concentration, insiderPct };
}

// ---- GoPlus: EVM token security (ETH / Base / BNB / …) -------------------

// DexScreener chainId → GoPlus numeric chain id.
const GOPLUS_CHAIN: Record<string, string> = {
  ethereum: '1',
  eth: '1',
  bsc: '56',
  binance: '56',
  bnb: '56',
  base: '8453',
  arbitrum: '42161',
  polygon: '137',
  optimism: '10',
  avalanche: '43114',
  fantom: '250',
  linea: '59144',
  scroll: '534352',
  zksync: '324',
};
// Chains we probe when DexScreener didn't tell us which one (biggest first).
const GOPLUS_PROBE = ['1', '56', '8453', '42161', '137'];
const DEAD_OWNERS = new Set(['', '0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);

interface GoPlusHolder {
  percent?: string;
  is_locked?: number;
  tag?: string;
  is_contract?: number;
}
interface GoPlusResult {
  token_name?: string;
  token_symbol?: string;
  holder_count?: string;
  is_honeypot?: string;
  cannot_sell_all?: string;
  buy_tax?: string;
  sell_tax?: string;
  is_open_source?: string;
  is_proxy?: string;
  is_mintable?: string;
  owner_address?: string;
  owner_percent?: string;
  creator_percent?: string;
  can_take_back_ownership?: string;
  hidden_owner?: string;
  transfer_pausable?: string;
  is_blacklisted?: string;
  trading_cooldown?: string;
  holders?: GoPlusHolder[];
  lp_holders?: GoPlusHolder[];
}

async function goPlusCall(chainId: string, address: string): Promise<GoPlusResult | null> {
  const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${encodeURIComponent(address)}`;
  const res = await fetchWithTimeout(url, {}, 10_000);
  if (!res.ok) throw new Error(`goplus ${res.status}`);
  const data = (await res.json()) as { code?: number; result?: Record<string, GoPlusResult> };
  const r = data.result?.[address.toLowerCase()] ?? Object.values(data.result ?? {})[0];
  // GoPlus returns an empty object for a token it doesn't index on that chain.
  if (!r || Object.keys(r).length === 0) return null;
  return r;
}

async function fetchGoPlus(
  address: string,
  dexChainId: string | null,
): Promise<{ result: GoPlusResult; chainId: string } | null> {
  const mapped = dexChainId ? GOPLUS_CHAIN[dexChainId.toLowerCase()] : undefined;
  if (mapped) {
    const r = await goPlusCall(mapped, address);
    return r ? { result: r, chainId: mapped } : null;
  }
  // Unknown chain — probe the majors, first hit wins.
  const hits = await Promise.all(
    GOPLUS_PROBE.map((c) => goPlusCall(c, address).then((r) => (r ? { result: r, chainId: c } : null)).catch(() => null)),
  );
  return hits.find((h): h is { result: GoPlusResult; chainId: string } => h != null) ?? null;
}

const bool01 = (v: string | undefined): boolean | null => (v == null ? null : v === '1');
const pct = (v: string | undefined): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? round2(n * 100) : null;
};

function mapGoPlus(r: GoPlusResult, chainId: string, address: string): {
  holders: number | null;
  top: TopHolder[];
  concentration: number | null;
  lpLockedPct: number | null;
  risks: { name: string; level: string; description: string }[];
  evm: EvmSecurity;
} {
  const holderList = r.holders ?? [];
  const mapped: TopHolder[] = holderList.map((h) => {
    const isPool = POOL_TYPE.test(h.tag ?? '') || Boolean(h.is_contract && h.tag);
    return { pct: pct(h.percent) ?? 0, insider: false, label: h.tag || undefined, is_pool: isPool };
  });
  const nonPool = mapped.filter((h) => !h.is_pool).slice(0, 10);
  const concentration = nonPool.length ? round2(nonPool.reduce((s, h) => s + h.pct, 0)) : null;

  const lpList = r.lp_holders ?? [];
  const lpLockedPct = lpList.length
    ? round2(lpList.filter((h) => h.is_locked === 1).reduce((s, h) => s + (pct(h.percent) ?? 0), 0))
    : null;

  const buyTax = pct(r.buy_tax);
  const sellTax = pct(r.sell_tax);
  const ownershipRenounced = r.owner_address != null ? DEAD_OWNERS.has(r.owner_address.toLowerCase()) : null;

  const risks: { name: string; level: string; description: string }[] = [];
  const add = (cond: boolean | null, name: string, level: string, description: string) => {
    if (cond) risks.push({ name, level, description });
  };
  add(bool01(r.is_honeypot), 'Honeypot', 'danger', 'Simulated sells fail — likely cannot sell.');
  add(bool01(r.cannot_sell_all), 'Cannot sell all', 'danger', 'Holders may be unable to sell their full balance.');
  add(bool01(r.can_take_back_ownership), 'Ownership reclaimable', 'danger', 'Owner can take back ownership after renouncing.');
  add(bool01(r.hidden_owner), 'Hidden owner', 'danger', 'Contract has a hidden owner.');
  const maxTax = Math.max(buyTax ?? 0, sellTax ?? 0);
  add(maxTax >= 50, 'Extreme tax', 'danger', `Buy ${buyTax ?? '?'}% / sell ${sellTax ?? '?'}%.`);
  add(maxTax >= 10 && maxTax < 50, 'High tax', 'warn', `Buy ${buyTax ?? '?'}% / sell ${sellTax ?? '?'}%.`);
  add(bool01(r.is_mintable), 'Mintable', 'warn', 'Supply can be increased by minting.');
  add(bool01(r.is_open_source) === false, 'Closed source', 'warn', 'Contract is not verified / open source.');
  add(bool01(r.transfer_pausable), 'Pausable transfers', 'warn', 'Transfers can be paused by the owner.');
  add(bool01(r.is_blacklisted), 'Blacklist function', 'warn', 'Owner can blacklist addresses from trading.');
  add(bool01(r.trading_cooldown), 'Trading cooldown', 'warn', 'Contract enforces a cooldown between trades.');
  add(bool01(r.is_proxy), 'Proxy contract', 'info', 'Upgradeable proxy — logic can change.');

  return {
    holders: r.holder_count != null ? Number(r.holder_count) : null,
    top: nonPool,
    concentration,
    lpLockedPct,
    risks,
    evm: {
      chain_id: chainId,
      is_honeypot: bool01(r.is_honeypot),
      buy_tax_pct: buyTax,
      sell_tax_pct: sellTax,
      cannot_sell_all: bool01(r.cannot_sell_all),
      is_open_source: bool01(r.is_open_source),
      is_proxy: bool01(r.is_proxy),
      is_mintable: bool01(r.is_mintable),
      ownership_renounced: ownershipRenounced,
      owner_percent: pct(r.owner_percent),
      creator_percent: pct(r.creator_percent),
      can_take_back_ownership: bool01(r.can_take_back_ownership),
      hidden_owner: bool01(r.hidden_owner),
      transfer_pausable: bool01(r.transfer_pausable),
      is_blacklisted: bool01(r.is_blacklisted),
      trading_cooldown: bool01(r.trading_cooldown),
      goplus_url: `https://gopluslabs.io/token-security/${chainId}/${address}`,
    },
  };
}

// ---- Solana Tracker: smart-money proxy (top traders by PnL) --------------

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function shortWallet(w: string): string {
  return w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w;
}

async function fetchSmartMoney(mint: string): Promise<SmartMoney | null> {
  const key = getConfig().SOLANA_TRACKER_API_KEY;
  if (!key) return null;
  const url = `https://data.solanatracker.io/top-traders/${encodeURIComponent(mint)}`;
  const res = await fetchWithTimeout(url, { headers: { 'x-api-key': key } }, 10_000);
  if (res.status === 401 || res.status === 402 || res.status === 429) {
    console.warn(`[token_scan] solana-tracker auth/quota ${res.status}`);
    return null;
  }
  if (!res.ok) throw new Error(`solana-tracker ${res.status}`);
  const raw: unknown = await res.json();
  // Defensive: REST may return a bare array or { wallets: [...] }, and each
  // entry may nest metrics under `summary` or carry them flat.
  const list: Record<string, unknown>[] = Array.isArray(raw)
    ? (raw as Record<string, unknown>[])
    : Array.isArray((raw as { wallets?: unknown }).wallets)
      ? ((raw as { wallets: Record<string, unknown>[] }).wallets)
      : [];
  if (list.length === 0) return null;

  const traders = list.map((e) => {
    const s = (e.summary as Record<string, unknown>) ?? e;
    const realized = num(s.realized);
    const unrealized = num(s.unrealized);
    const total = num(s.total) ?? (realized != null && unrealized != null ? realized + unrealized : null);
    const holding = num(s.holding) ?? num((e as Record<string, unknown>).holding);
    // If the API gives a holding balance, trust it; else infer from a live
    // unrealized figure (you only carry unrealized PnL on an open position).
    const stillHolding =
      holding != null ? holding > 0 : unrealized != null ? Math.abs(unrealized) > 0 : null;
    return {
      wallet: shortWallet(String(e.wallet ?? (e as Record<string, unknown>).address ?? '')),
      realized_pnl_usd: realized,
      total_pnl_usd: total,
      win_rate_pct: num(s.winPercentage) ?? num((s as Record<string, unknown>).win_percentage),
      still_holding: stillHolding,
    };
  });

  const cohortRealized = traders.reduce((sum, t) => sum + (t.realized_pnl_usd ?? 0), 0);
  const holdingCount = traders.filter((t) => t.still_holding === true).length;
  const exitedCount = traders.filter((t) => t.still_holding === false).length;
  const top = [...traders]
    .sort((a, b) => (b.total_pnl_usd ?? 0) - (a.total_pnl_usd ?? 0))
    .slice(0, 5);

  return {
    trader_count: traders.length,
    still_holding: holdingCount,
    exited: exitedCount,
    cohort_realized_pnl_usd: round2(cohortRealized),
    top,
  };
}

// ---- Tool ----------------------------------------------------------------

const EVM_RE = EVM_ADDR_RE;
const cache = makeCache<Output>(45_000);

export const tokenScanTool: Tool<Input, Output> = {
  name: 'token_scan',
  description:
    'Full degen/memecoin scan of a token by CONTRACT ADDRESS on Solana OR any major EVM chain (Ethereum, Base, BNB/BSC, Arbitrum, Polygon, …). Returns market data (price, FDV, liquidity, 24h volume, age, buy/sell txns, socials) AND on-chain security: total holders, top-holder concentration, LP locked %, and risk flags — for Solana via RugCheck (insider %, network insiders, mint/freeze authority, metadata mutability), for EVM via GoPlus (honeypot, buy/sell tax, ownership renounced, mintable, closed-source, pausable, blacklist, reclaimable ownership). Use this (not crypto_price / dex_token_lookup) whenever a user pastes a contract address — Solana pump.fun mint or an EVM 0x… launch — or asks "is this safe / bundled / a honeypot / who holds this".',
  inputSchema: {
    type: 'object',
    properties: {
      address: {
        type: 'string',
        description: 'Token contract address / mint — Solana base58 or EVM 0x… .',
      },
    },
    required: ['address'],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    const address = input.address.trim();
    const isEvm = EVM_RE.test(address);
    return withRetry(
      () =>
        cache.wrap(address.toLowerCase(), async () => {
          // Market data first — for EVM its chainId picks the GoPlus chain.
          const dex = await fetchDex(address).catch((e) => {
            console.warn(`[token_scan] dexscreener: ${(e as Error).message}`);
            return null;
          });

          // Security + smart-money in parallel; all best-effort (fail → null).
          const solEnrich = !isEvm && solanaTrackerEnabled();
          const [rc, gp, sm] = await Promise.all([
            isEvm
              ? Promise.resolve(null)
              : fetchRugcheck(address).catch((e) => {
                  console.warn(`[token_scan] rugcheck: ${(e as Error).message}`);
                  return null;
                }),
            isEvm
              ? fetchGoPlus(address, dex?.chainId ?? null).catch((e) => {
                  console.warn(`[token_scan] goplus: ${(e as Error).message}`);
                  return null;
                })
              : Promise.resolve(null),
            solEnrich
              ? fetchSmartMoney(address).catch((e) => {
                  console.warn(`[token_scan] solana-tracker: ${(e as Error).message}`);
                  return null;
                })
              : Promise.resolve(null),
          ]);

          if (!dex && !rc && !gp) throw new Error(`No data found for ${address}`);

          const solHolders = rc ? mapTopHolders(rc) : null;
          const evm = gp ? mapGoPlus(gp.result, gp.chainId, address) : null;
          const ageHours =
            dex?.pairCreatedAt != null
              ? Math.max(0, Math.round((Date.now() - dex.pairCreatedAt) / 3_600_000))
              : null;
          const socials = [...(dex?.info?.websites ?? []), ...(dex?.info?.socials ?? [])]
            .map((s) => s.url)
            .filter((u): u is string => Boolean(u));

          return {
            address,
            chain: dex?.chainId ?? (isEvm ? 'evm' : 'solana'),
            symbol: dex?.baseToken.symbol ?? rc?.tokenMeta?.symbol ?? gp?.result.token_symbol ?? null,
            name: dex?.baseToken.name ?? rc?.tokenMeta?.name ?? gp?.result.token_name ?? null,
            price_usd: dex ? Number(dex.priceUsd ?? '0') : null,
            fdv: dex?.fdv ?? null,
            market_cap: dex?.marketCap ?? null,
            liquidity_usd: dex?.liquidity?.usd ?? null,
            vol_24h_usd: dex?.volume?.h24 ?? null,
            change_24h_pct: dex?.priceChange?.h24 ?? null,
            txns_24h: dex?.txns?.h24
              ? { buys: dex.txns.h24.buys ?? 0, sells: dex.txns.h24.sells ?? 0 }
              : null,
            age_hours: ageHours,
            socials,
            dex_url: dex?.url ?? null,
            security_available: Boolean(rc || evm),
            holders: rc?.totalHolders ?? evm?.holders ?? null,
            top_holders: solHolders?.top ?? evm?.top ?? [],
            top10_concentration_pct: solHolders ? round2(solHolders.concentration) : evm?.concentration ?? null,
            lp_locked_pct: rc ? primaryLpLockedPct(rc) : evm?.lpLockedPct ?? null,
            risks: rc?.risks ?? evm?.risks ?? [],
            insider_held_pct: solHolders ? round2(solHolders.insiderPct) : null,
            insiders_detected: rc?.graphInsidersDetected ?? null,
            mint_authority_renounced: rc ? rc.mintAuthority == null : null,
            freeze_authority_renounced: rc ? rc.freezeAuthority == null : null,
            metadata_mutable: rc?.tokenMeta?.mutable ?? null,
            rugged: rc?.rugged ?? null,
            risk_score: rc?.score_normalised ?? null,
            launchpad: normalizeLaunchpad(
              (typeof rc?.launchpad === 'object' ? rc?.launchpad?.name : rc?.launchpad) ??
                rc?.deployPlatform,
            ),
            rugcheck_url: rc ? `https://rugcheck.xyz/tokens/${address}` : null,
            evm_security: evm?.evm ?? null,
            smart_money: sm,
          };
        }),
      `token_scan:${address}`,
    );
  },
  citation: (_, out) => ({
    label: out.security_available
      ? `Scan (${out.symbol ?? 'token'} · ${out.chain})`
      : `DexScreener (${out.symbol ?? 'token'} · ${out.chain})`,
    url: out.rugcheck_url ?? out.evm_security?.goplus_url ?? out.dex_url ?? undefined,
  }),
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function normalizeLaunchpad(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.toLowerCase() !== 'unknown' ? t : null;
}
