import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { getConfig } from '../config.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';

/**
 * Finnhub (finnhub.io) — equity data on the free tier. Powers Paul's
 * all-rounder equity coverage so a company's fundamentals, growth, and
 * earnings can be read alongside crypto (equities move risk appetite, and
 * HIP-3 tokenizes many of these same names on Hyperliquid).
 *
 * Free-tier endpoints used (auth via X-Finnhub-Token header):
 *   /quote, /stock/profile2, /stock/metric?metric=all,
 *   /stock/earnings, /calendar/earnings, /stock/recommendation
 *
 * All three tools are gated on FINNHUB_API_KEY (registered only when set).
 * POST-MVP: Quartr for earnings-call transcripts/guidance tone; FMP for
 * full line-item statements; paid consensus estimate feeds.
 */

const BASE = 'https://finnhub.io/api/v1';
const jsonCache = makeCache<unknown>(60_000); // 60s per endpoint+symbol

async function finnhubGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const key = getConfig().FINNHUB_API_KEY;
  if (!key) throw new Error('FINNHUB_API_KEY not set');
  const qs = new URLSearchParams(params).toString();
  const cacheKey = `${path}?${qs}`;
  const hit = jsonCache.get(cacheKey);
  if (hit !== undefined) return hit as T;
  const res = await fetchWithTimeout(`${BASE}${path}?${qs}`, {
    headers: { 'X-Finnhub-Token': key },
  });
  if (res.status === 401 || res.status === 403) throw new Error(`finnhub auth ${res.status} (check key/tier)`);
  if (res.status === 429) throw new Error('finnhub rate limit (429)');
  if (!res.ok) throw new Error(`finnhub ${path} ${res.status}`);
  const data = (await res.json()) as T;
  jsonCache.set(cacheKey, data);
  return data;
}

function sym(input: { symbol: string }): string {
  return input.symbol.trim().toUpperCase().replace(/^\$/, '');
}
function n(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
/** Pull the first present numeric value across candidate metric keys. */
function pick(metric: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const val = n(metric[k]);
    if (val !== null) return val;
  }
  return null;
}

// ---- Shared Finnhub response shapes --------------------------------------

interface Profile2 {
  name?: string;
  ticker?: string;
  exchange?: string;
  finnhubIndustry?: string;
  country?: string;
  currency?: string;
  marketCapitalization?: number; // in millions
  shareOutstanding?: number; // in millions
  ipo?: string;
  weburl?: string;
}
interface Quote {
  c?: number; // current
  d?: number; // change
  dp?: number; // change %
  h?: number;
  l?: number;
  o?: number;
  pc?: number; // prev close
}
interface MetricResp {
  metric?: Record<string, unknown>;
}

// ================= equity_snapshot ========================================

const SymbolSchema = z.object({
  symbol: z.string().min(1).describe('Stock ticker, e.g. "AAPL", "NVDA", "MSTR".'),
});
type SymbolInput = z.infer<typeof SymbolSchema>;

interface SnapshotOut {
  symbol: string;
  name: string | null;
  exchange: string | null;
  industry: string | null;
  currency: string | null;
  price: number | null;
  change: number | null;
  change_pct: number | null;
  day_high: number | null;
  day_low: number | null;
  prev_close: number | null;
  market_cap_usd: number | null; // absolute USD
  shares_outstanding_m: number | null;
  week52_high: number | null;
  week52_low: number | null;
  pe_ttm: number | null;
  ps_ttm: number | null;
  source_url: string;
}

export const equitySnapshotTool: Tool<SymbolInput, SnapshotOut> = {
  name: 'equity_snapshot',
  description:
    'Live snapshot of a listed stock by ticker: price, day move, market cap, 52-week range, P/E and P/S, exchange and industry. Use for "what is <company>", "how is <ticker> trading", or to ground any equity discussion. Also useful for tokenized-equity names traded on Hyperliquid (TSLA, NVDA, etc.).',
  inputSchema: {
    type: 'object',
    properties: { symbol: { type: 'string', description: 'Stock ticker (e.g. "AAPL", "NVDA").' } },
    required: ['symbol'],
  },
  validate: zValidator(SymbolSchema),
  execute: async (input) => {
    const symbol = sym(input);
    return withRetry(async () => {
      const [profile, quote, metricResp] = await Promise.all([
        finnhubGet<Profile2>('/stock/profile2', { symbol }),
        finnhubGet<Quote>('/quote', { symbol }),
        finnhubGet<MetricResp>('/stock/metric', { symbol, metric: 'all' }).catch(() => ({ metric: {} })),
      ]);
      const m = metricResp.metric ?? {};
      if (!profile.name && !n(quote.c)) throw new Error(`No data for "${symbol}" (unknown ticker?)`);
      return {
        symbol,
        name: profile.name ?? null,
        exchange: profile.exchange ?? null,
        industry: profile.finnhubIndustry ?? null,
        currency: profile.currency ?? null,
        price: n(quote.c),
        change: n(quote.d),
        change_pct: n(quote.dp),
        day_high: n(quote.h),
        day_low: n(quote.l),
        prev_close: n(quote.pc),
        market_cap_usd: profile.marketCapitalization != null ? profile.marketCapitalization * 1_000_000 : null,
        shares_outstanding_m: n(profile.shareOutstanding),
        week52_high: pick(m, '52WeekHigh'),
        week52_low: pick(m, '52WeekLow'),
        pe_ttm: pick(m, 'peTTM', 'peBasicExclExtraTTM', 'peInclExtraTTM'),
        ps_ttm: pick(m, 'psTTM', 'psAnnual'),
        source_url: profile.weburl || `https://finnhub.io/quote/${symbol}`,
      };
    }, `finnhub:snapshot:${symbol}`);
  },
  citation: (_, out) => ({ label: `Finnhub (${out.symbol})`, url: out.source_url }),
};

// ================= equity_fundamentals ====================================

interface FundamentalsOut {
  symbol: string;
  // Growth (%)
  revenue_growth_yoy_pct: number | null;
  revenue_growth_5y_pct: number | null;
  eps_growth_yoy_pct: number | null;
  eps_growth_5y_pct: number | null;
  // Profitability (%)
  gross_margin_pct: number | null;
  operating_margin_pct: number | null;
  net_margin_pct: number | null;
  roe_pct: number | null;
  roa_pct: number | null;
  // Leverage / liquidity
  debt_to_equity: number | null;
  current_ratio: number | null;
  // Per-share / valuation
  eps_ttm: number | null;
  revenue_per_share_ttm: number | null;
  pe_ttm: number | null;
  ps_ttm: number | null;
  pb: number | null;
  ev_ebitda: number | null;
  dividend_yield_pct: number | null;
}

export const equityFundamentalsTool: Tool<SymbolInput, FundamentalsOut> = {
  name: 'equity_fundamentals',
  description:
    "A company's financial health by ticker: revenue and EPS growth (YoY and 5-year), gross/operating/net margins, ROE/ROA, debt-to-equity, current ratio, EPS, and valuation multiples (P/E, P/S, P/B, EV/EBITDA, dividend yield). Use for questions about fundamentals, financials, growth, margins, profitability, or whether a company is cheap/expensive.",
  inputSchema: {
    type: 'object',
    properties: { symbol: { type: 'string', description: 'Stock ticker (e.g. "AAPL", "NVDA").' } },
    required: ['symbol'],
  },
  validate: zValidator(SymbolSchema),
  execute: async (input) => {
    const symbol = sym(input);
    return withRetry(async () => {
      const resp = await finnhubGet<MetricResp>('/stock/metric', { symbol, metric: 'all' });
      const m = resp.metric ?? {};
      if (Object.keys(m).length === 0) throw new Error(`No fundamentals for "${symbol}" (unknown ticker?)`);
      return {
        symbol,
        revenue_growth_yoy_pct: pick(m, 'revenueGrowthTTMYoy', 'revenueGrowthQuarterlyYoy'),
        revenue_growth_5y_pct: pick(m, 'revenueGrowth5Y'),
        eps_growth_yoy_pct: pick(m, 'epsGrowthTTMYoy', 'epsGrowthQuarterlyYoy'),
        eps_growth_5y_pct: pick(m, 'epsGrowth5Y'),
        gross_margin_pct: pick(m, 'grossMarginTTM', 'grossMarginAnnual'),
        operating_margin_pct: pick(m, 'operatingMarginTTM', 'operatingMarginAnnual'),
        net_margin_pct: pick(m, 'netProfitMarginTTM', 'netProfitMarginAnnual'),
        roe_pct: pick(m, 'roeTTM', 'roeRfy'),
        roa_pct: pick(m, 'roaTTM', 'roaRfy'),
        debt_to_equity: pick(m, 'totalDebt/totalEquityQuarterly', 'totalDebt/totalEquityAnnual', 'longTermDebt/equityQuarterly'),
        current_ratio: pick(m, 'currentRatioQuarterly', 'currentRatioAnnual'),
        eps_ttm: pick(m, 'epsTTM', 'epsInclExtraItemsTTM'),
        revenue_per_share_ttm: pick(m, 'revenuePerShareTTM'),
        pe_ttm: pick(m, 'peTTM', 'peBasicExclExtraTTM'),
        ps_ttm: pick(m, 'psTTM'),
        pb: pick(m, 'pbQuarterly', 'pbAnnual'),
        ev_ebitda: pick(m, 'currentEv/freeCashFlowTTM', 'evEbitdaTTM'),
        dividend_yield_pct: pick(m, 'dividendYieldIndicatedAnnual', 'currentDividendYieldTTM'),
      };
    }, `finnhub:fundamentals:${symbol}`);
  },
  citation: (_, out) => ({ label: `Finnhub fundamentals (${out.symbol})`, url: `https://finnhub.io/quote/${out.symbol}` }),
};

// ================= equity_earnings ========================================

interface EarningsSurprise {
  period?: string;
  actual?: number;
  estimate?: number;
  surprise?: number;
  surprisePercent?: number;
}
interface CalendarResp {
  earningsCalendar?: Array<{
    date?: string;
    epsEstimate?: number;
    epsActual?: number;
    revenueEstimate?: number;
    revenueActual?: number;
    hour?: string; // bmo / amc / dmh
    quarter?: number;
    year?: number;
  }>;
}
interface Recommendation {
  period?: string;
  strongBuy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strongSell?: number;
}

interface EarningsOut {
  symbol: string;
  next_earnings_date: string | null;
  next_earnings_when: string | null; // before open / after close
  consensus_eps_estimate: number | null;
  consensus_revenue_estimate: number | null;
  recent_surprises: { period: string; actual: number | null; estimate: number | null; surprise_pct: number | null }[];
  beats: number; // of the reported quarters below
  reported: number;
  latest_recommendation: { strong_buy: number; buy: number; hold: number; sell: number; strong_sell: number; period: string } | null;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function whenLabel(hour: string | undefined): string | null {
  if (hour === 'bmo') return 'before open';
  if (hour === 'amc') return 'after close';
  if (hour === 'dmh') return 'during market hours';
  return null;
}

export const equityEarningsTool: Tool<SymbolInput, EarningsOut> = {
  name: 'equity_earnings',
  description:
    "A stock's earnings picture by ticker: the next earnings date (and whether before open / after close), the consensus EPS and revenue estimate for it, the recent history of beats vs. misses (actual vs. estimate and surprise %), and the current analyst recommendation split. Use for earnings questions and to PREDICT an upcoming print — reason from the beat/miss pattern, growth trend, and consensus. Never state a prediction as certainty.",
  inputSchema: {
    type: 'object',
    properties: { symbol: { type: 'string', description: 'Stock ticker (e.g. "AAPL", "NVDA").' } },
    required: ['symbol'],
  },
  validate: zValidator(SymbolSchema),
  execute: async (input) => {
    const symbol = sym(input);
    return withRetry(async () => {
      const today = new Date();
      const in120 = new Date(today.getTime() + 120 * 86_400_000);
      const [earnings, calendar, recs] = await Promise.all([
        finnhubGet<EarningsSurprise[]>('/stock/earnings', { symbol }).catch(() => [] as EarningsSurprise[]),
        finnhubGet<CalendarResp>('/calendar/earnings', {
          symbol,
          from: isoDay(today),
          to: isoDay(in120),
        }).catch(() => ({ earningsCalendar: [] })),
        finnhubGet<Recommendation[]>('/stock/recommendation', { symbol }).catch(() => [] as Recommendation[]),
      ]);

      // Next upcoming earnings = earliest calendar entry dated today or later.
      const upcoming = (calendar.earningsCalendar ?? [])
        .filter((e) => e.date && e.date >= isoDay(today))
        .sort((a, b) => (a.date! < b.date! ? -1 : 1))[0];

      const surprises = (earnings ?? []).slice(0, 4).map((e) => ({
        period: e.period ?? '',
        actual: n(e.actual),
        estimate: n(e.estimate),
        surprise_pct: n(e.surprisePercent),
      }));
      const reportedRows = surprises.filter((s) => s.actual !== null && s.estimate !== null);
      const beats = reportedRows.filter((s) => (s.actual as number) > (s.estimate as number)).length;

      const rec = (recs ?? [])[0];

      return {
        symbol,
        next_earnings_date: upcoming?.date ?? null,
        next_earnings_when: whenLabel(upcoming?.hour),
        consensus_eps_estimate: n(upcoming?.epsEstimate),
        consensus_revenue_estimate: n(upcoming?.revenueEstimate),
        recent_surprises: surprises,
        beats,
        reported: reportedRows.length,
        latest_recommendation: rec
          ? {
              strong_buy: rec.strongBuy ?? 0,
              buy: rec.buy ?? 0,
              hold: rec.hold ?? 0,
              sell: rec.sell ?? 0,
              strong_sell: rec.strongSell ?? 0,
              period: rec.period ?? '',
            }
          : null,
      };
    }, `finnhub:earnings:${symbol}`);
  },
  citation: (_, out) => ({ label: `Finnhub earnings (${out.symbol})`, url: `https://finnhub.io/quote/${out.symbol}` }),
};
