import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';

/**
 * Commodities, FX and rates spot quotes — the asset classes Pip could talk
 * about but had no way to LOOK UP. Before this tool, "what's gold at" fell
 * through to the model's parametric memory and produced a stale number
 * (it quoted ~$3,300 while gold was ~$4,141 — near the 52w low, and it
 * inverted the whole read).
 *
 * Source: Yahoo Finance chart endpoint. No API key, so this is always
 * registered — a keyless source is the point, since the failure mode we're
 * fixing is "no tool available, so guess".
 */

// Friendly name → Yahoo symbol. Raw Yahoo symbols also pass through.
const SYMBOLS: Record<string, { sym: string; label: string; unit: string }> = {
  gold: { sym: 'GC=F', label: 'Gold (COMEX front-month)', unit: 'USD/oz' },
  xau: { sym: 'GC=F', label: 'Gold (COMEX front-month)', unit: 'USD/oz' },
  silver: { sym: 'SI=F', label: 'Silver (COMEX front-month)', unit: 'USD/oz' },
  xag: { sym: 'SI=F', label: 'Silver (COMEX front-month)', unit: 'USD/oz' },
  platinum: { sym: 'PL=F', label: 'Platinum (NYMEX)', unit: 'USD/oz' },
  copper: { sym: 'HG=F', label: 'Copper (COMEX)', unit: 'USD/lb' },
  oil: { sym: 'CL=F', label: 'WTI crude (NYMEX)', unit: 'USD/bbl' },
  wti: { sym: 'CL=F', label: 'WTI crude (NYMEX)', unit: 'USD/bbl' },
  brent: { sym: 'BZ=F', label: 'Brent crude', unit: 'USD/bbl' },
  natgas: { sym: 'NG=F', label: 'Natural gas (NYMEX)', unit: 'USD/MMBtu' },
  'natural gas': { sym: 'NG=F', label: 'Natural gas (NYMEX)', unit: 'USD/MMBtu' },
  wheat: { sym: 'ZW=F', label: 'Wheat (CBOT)', unit: 'USc/bu' },
  corn: { sym: 'ZC=F', label: 'Corn (CBOT)', unit: 'USc/bu' },
  palladium: { sym: 'PA=F', label: 'Palladium (NYMEX)', unit: 'USD/oz' },
  dxy: { sym: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', unit: 'index' },
  dollar: { sym: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', unit: 'index' },
  '10y': { sym: '^TNX', label: 'US 10-year Treasury yield', unit: '%' },
  '5y': { sym: '^FVX', label: 'US 5-year Treasury yield', unit: '%' },
  '30y': { sym: '^TYX', label: 'US 30-year Treasury yield', unit: '%' },
  // No 2y index on Yahoo — macro_indicator ("2y" → FRED DGS2) covers that.
  vix: { sym: '^VIX', label: 'CBOE Volatility Index (VIX)', unit: 'index' },
  spx: { sym: '^GSPC', label: 'S&P 500', unit: 'index' },
  sp500: { sym: '^GSPC', label: 'S&P 500', unit: 'index' },
  's&p': { sym: '^GSPC', label: 'S&P 500', unit: 'index' },
  's&p 500': { sym: '^GSPC', label: 'S&P 500', unit: 'index' },
  ndx: { sym: '^NDX', label: 'Nasdaq 100', unit: 'index' },
  nasdaq: { sym: '^NDX', label: 'Nasdaq 100', unit: 'index' },
  // "dow" as a bare ticker is Dow Inc (a chemicals company) — never the index.
  dow: { sym: '^DJI', label: 'Dow Jones Industrial Average', unit: 'index' },
  djia: { sym: '^DJI', label: 'Dow Jones Industrial Average', unit: 'index' },
  'dow jones': { sym: '^DJI', label: 'Dow Jones Industrial Average', unit: 'index' },
  russell: { sym: '^RUT', label: 'Russell 2000', unit: 'index' },
  'russell 2000': { sym: '^RUT', label: 'Russell 2000', unit: 'index' },
  // Likewise "dax" as a bare ticker is an unrelated US-listed stock.
  dax: { sym: '^GDAXI', label: 'DAX (Germany)', unit: 'index' },
  nikkei: { sym: '^N225', label: 'Nikkei 225 (Japan)', unit: 'index' },
  ftse: { sym: '^FTSE', label: 'FTSE 100 (UK)', unit: 'index' },
  'hang seng': { sym: '^HSI', label: 'Hang Seng (Hong Kong)', unit: 'index' },
  hangseng: { sym: '^HSI', label: 'Hang Seng (Hong Kong)', unit: 'index' },
  eurusd: { sym: 'EURUSD=X', label: 'EUR/USD', unit: 'rate' },
  usdjpy: { sym: 'JPY=X', label: 'USD/JPY', unit: 'rate' },
  gbpusd: { sym: 'GBPUSD=X', label: 'GBP/USD', unit: 'rate' },
  audusd: { sym: 'AUDUSD=X', label: 'AUD/USD', unit: 'rate' },
  nzdusd: { sym: 'NZDUSD=X', label: 'NZD/USD', unit: 'rate' },
  usdcad: { sym: 'USDCAD=X', label: 'USD/CAD', unit: 'rate' },
  usdchf: { sym: 'USDCHF=X', label: 'USD/CHF', unit: 'rate' },
  usdcnh: { sym: 'USDCNH=X', label: 'USD/CNH', unit: 'rate' },
};

const InputSchema = z.object({
  asset: z
    .string()
    .min(1)
    .describe('Asset name — e.g. "gold", "silver", "oil", "dxy", "vix", "10y", "spx" — or a raw Yahoo symbol ("GC=F").'),
});
type Input = z.infer<typeof InputSchema>;

interface Output {
  asset: string;
  symbol: string;
  unit: string;
  price: number;
  prev_close: number | null;
  change: number | null;
  change_pct: number | null;
  day_high: number | null;
  day_low: number | null;
  week52_high: number | null;
  week52_low: number | null;
  /** Where price sits in its 52-week range, 0 = at the low, 100 = at the high. */
  pct_of_52w_range: number | null;
  as_of: string;
  source_url: string;
}

interface YahooMeta {
  symbol?: string;
  currency?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  regularMarketTime?: number;
  shortName?: string;
}

const quoteCache = makeCache<Output>(60_000); // 60s — these move slower than crypto

/**
 * Yahoo symbols carry a class marker: ^ = index, =F = future, =X = FX pair,
 * . = foreign listing. A BARE word has none, and passing one through is
 * actively dangerous: "dow" is a live equity ticker (Dow Inc, ~$31) that
 * silently returns instead of the Dow Jones index (~52,000), and "dax" hits
 * an unrelated US listing rather than the German index. A 404 is recoverable;
 * a confident wrong number is the exact failure this whole tool exists to
 * prevent. So we only pass through symbols that are explicitly marked.
 */
const MARKED_SYMBOL = /[\^=.]/;

function resolve(asset: string): { sym: string; label: string; unit: string } {
  const raw = asset.trim().replace(/^\$/, '');
  const hit = SYMBOLS[raw.toLowerCase()];
  if (hit) return hit;
  if (MARKED_SYMBOL.test(raw)) {
    const sym = raw.toUpperCase();
    return { sym, label: sym, unit: '' };
  }
  throw new Error(
    `"${asset}" is not a known commodity/FX/index/rate name. Use one of: ${Object.keys(SYMBOLS)
      .slice(0, 12)
      .join(', ')}… — or an explicit Yahoo symbol (^DJI, GC=F, EURUSD=X). ` +
      `For a single stock or ETF ticker use equity_snapshot instead; for a coin use crypto_price.`,
  );
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export const commoditySpotTool: Tool<Input, Output> = {
  name: 'commodity_fx_rates_spot',
  description:
    'Live price for a commodity, FX pair, index or Treasury yield. Metals: gold, silver, platinum, palladium, copper. Energy: oil/WTI, brent, natgas. Ags: wheat, corn. FX: eurusd, usdjpy, gbpusd, audusd, nzdusd, usdcad, usdchf, usdcnh. Indices: spx, ndx, dow, russell, dax, nikkei, ftse, hang seng, vix. Rates: 5y, 10y, 30y. Returns price, day change, day range and the 52-week range (so you can say where in its range price actually sits). Call this for ANY question touching these assets, including when they are only a side note in a wider macro or crypto read — you have no reliable memory of these levels and must not state one without calling this first. Not for single stocks or ETFs (use equity_snapshot) or coins (use crypto_price).',
  inputSchema: {
    type: 'object',
    properties: {
      asset: {
        type: 'string',
        description: 'Asset name ("gold", "oil", "dxy", "vix", "10y", "spx") or a raw Yahoo symbol ("GC=F").',
      },
    },
    required: ['asset'],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    const { sym, label, unit } = resolve(input.asset);
    return withRetry(async () => {
      return quoteCache.wrap(sym, async () => {
        const url =
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
          `?interval=1d&range=5d`;
        const res = await fetchWithTimeout(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PipBot/1.0)' },
        });
        if (!res.ok) throw new Error(`yahoo chart ${res.status} for ${sym}`);
        const j = (await res.json()) as {
          chart?: { result?: Array<{ meta?: YahooMeta }>; error?: { description?: string } | null };
        };
        if (j.chart?.error) throw new Error(`yahoo: ${j.chart.error.description ?? 'error'}`);
        const meta = j.chart?.result?.[0]?.meta;
        const price = num(meta?.regularMarketPrice);
        if (!meta || price === null) throw new Error(`No quote for "${input.asset}" (unknown symbol?)`);

        const prev = num(meta.chartPreviousClose) ?? num(meta.previousClose);
        const hi52 = num(meta.fiftyTwoWeekHigh);
        const lo52 = num(meta.fiftyTwoWeekLow);
        const span = hi52 !== null && lo52 !== null ? hi52 - lo52 : null;

        return {
          asset: meta.shortName ?? label,
          symbol: meta.symbol ?? sym,
          unit,
          price,
          prev_close: prev,
          change: prev === null ? null : price - prev,
          change_pct: prev ? ((price - prev) / prev) * 100 : null,
          day_high: num(meta.regularMarketDayHigh),
          day_low: num(meta.regularMarketDayLow),
          week52_high: hi52,
          week52_low: lo52,
          pct_of_52w_range:
            span !== null && span > 0 && lo52 !== null ? ((price - lo52) / span) * 100 : null,
          as_of: meta.regularMarketTime
            ? new Date(meta.regularMarketTime * 1000).toISOString()
            : new Date().toISOString(),
          source_url: `https://finance.yahoo.com/quote/${encodeURIComponent(meta.symbol ?? sym)}`,
        };
      });
    }, `yahoo:${sym}`);
  },
  citation: (_, out) => ({ label: `Yahoo Finance (${out.symbol})`, url: out.source_url }),
};
