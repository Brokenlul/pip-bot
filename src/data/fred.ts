import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry } from '../core/util.js';
import { getConfig } from '../config.js';

/**
 * FRED (Federal Reserve Economic Data, St. Louis Fed) — official US macro series.
 * Free, but requires an API key: https://fredaccount.stlouisfed.org/apikeys
 * Registered only when FRED_API_KEY is set (see agent.ts / fredEnabled()).
 * This is the "hard macro numbers" source: latest CPI, PCE, unemployment, GDP, yields.
 */

// Friendly aliases → FRED series IDs. Raw series IDs also pass through.
const SERIES_ALIASES: Record<string, string> = {
  cpi: 'CPIAUCSL',
  'core cpi': 'CPILFESL',
  core_cpi: 'CPILFESL',
  pce: 'PCEPI',
  'core pce': 'PCEPILFE',
  core_pce: 'PCEPILFE',
  inflation: 'CPIAUCSL',
  'fed funds': 'FEDFUNDS',
  fed_funds: 'FEDFUNDS',
  'fed funds rate': 'FEDFUNDS',
  // Target range endpoints — daily, so they confirm the CURRENT policy setting,
  // unlike FEDFUNDS (the monthly effective average, which lags a fresh decision).
  'target range upper': 'DFEDTARU',
  'target range lower': 'DFEDTARL',
  'fed funds target': 'DFEDTARU',
  // The macro deltas an FOMC read turns on between meetings.
  'real yield': 'DFII10',
  '10y real yield': 'DFII10',
  breakeven: 'T10YIE',
  'inflation expectations': 'T10YIE',
  '5y5y': 'T5YIFR',
  'financial conditions': 'NFCI',
  'yield curve': 'T10Y2Y',
  '2s10s': 'T10Y2Y',
  wti: 'DCOILWTICO',
  oil: 'DCOILWTICO',
  gasoline: 'GASREGW',
  'sticky cpi': 'CORESTICKM159SFRBATL',
  'balance sheet': 'WALCL',
  'fed balance sheet': 'WALCL',
  unemployment: 'UNRATE',
  'unemployment rate': 'UNRATE',
  jobless: 'ICSA',
  'initial claims': 'ICSA',
  gdp: 'GDPC1',
  'real gdp': 'GDPC1',
  m2: 'M2SL',
  '10y': 'DGS10',
  '10 year': 'DGS10',
  '10y treasury': 'DGS10',
  '2y': 'DGS2',
  '2 year': 'DGS2',
  '30y mortgage': 'MORTGAGE30US',
  'mortgage rate': 'MORTGAGE30US',
};

const InputSchema = z.object({
  series: z
    .string()
    .min(1)
    .describe('Economic indicator alias (e.g. "cpi", "unemployment", "fed funds", "10y") or a raw FRED series ID (e.g. "CPIAUCSL").'),
});
type Input = z.infer<typeof InputSchema>;

interface Output {
  series_id: string;
  title: string;
  units: string;
  frequency: string;
  latest_value: number;
  latest_date: string;
  previous_value: number | null;
  change: number | null;
  change_pct: number | null;
  source_url: string;
}

const obsCache = makeCache<Output>(60 * 60_000); // 1h — macro data updates infrequently
const metaCache = makeCache<{ title: string; units: string; frequency: string }>(24 * 60 * 60_000);

function resolveSeriesId(q: string): string {
  const key = q.trim().toLowerCase();
  if (SERIES_ALIASES[key]) return SERIES_ALIASES[key]!;
  // Assume the caller passed a raw series ID (FRED IDs are uppercase alnum).
  return q.trim().toUpperCase();
}

async function fetchMeta(seriesId: string, apiKey: string) {
  return metaCache.wrap(seriesId, async () => {
    const url = `https://api.stlouisfed.org/fred/series?series_id=${encodeURIComponent(seriesId)}&api_key=${apiKey}&file_type=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fred series meta ${res.status}`);
    const j = (await res.json()) as {
      seriess?: Array<{ title: string; units_short?: string; units?: string; frequency_short?: string; frequency?: string }>;
    };
    const s = j.seriess?.[0];
    if (!s) throw new Error(`Unknown FRED series: ${seriesId}`);
    return {
      title: s.title,
      units: s.units_short ?? s.units ?? '',
      frequency: s.frequency_short ?? s.frequency ?? '',
    };
  });
}

export const fredTool: Tool<Input, Output> = {
  name: 'macro_indicator',
  description:
    'Get the latest official US macroeconomic figure (with the prior reading and change) from FRED — the St. Louis Fed database. Handles CPI/core CPI/sticky CPI, PCE, unemployment, initial jobless claims, GDP, M2, Fed funds rate, the current fed funds TARGET RANGE ("target range upper"/"target range lower"), Treasury yields (2y/10y), the 10y real yield, breakeven and 5y5y inflation expectations, the 2s10s curve, financial conditions (NFCI), the Fed balance sheet, and WTI/gasoline. Use for "what is the latest CPI", "unemployment rate", "10-year yield", etc. Accepts a friendly name or a raw FRED series ID.',
  inputSchema: {
    type: 'object',
    properties: {
      series: {
        type: 'string',
        description: 'Indicator name ("cpi", "unemployment", "fed funds", "10y") or raw FRED series ID ("CPIAUCSL").',
      },
    },
    required: ['series'],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    const apiKey = getConfig().FRED_API_KEY;
    if (!apiKey) throw new Error('FRED_API_KEY not configured');
    const seriesId = resolveSeriesId(input.series);
    return withRetry(async () => {
      return obsCache.wrap(seriesId, async () => {
        const obsUrl =
          `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(seriesId)}` +
          `&api_key=${apiKey}&file_type=json&sort_order=desc&limit=2`;
        const [meta, res] = await Promise.all([fetchMeta(seriesId, apiKey), fetch(obsUrl)]);
        if (!res.ok) throw new Error(`fred observations ${res.status}`);
        const j = (await res.json()) as { observations?: Array<{ date: string; value: string }> };
        // FRED marks missing values as ".". Skip those.
        const obs = (j.observations ?? []).filter((o) => o.value !== '.');
        if (obs.length === 0) throw new Error(`No observations for FRED series ${seriesId}`);
        const latest = obs[0]!;
        const prev = obs[1] ?? null;
        const latestVal = Number(latest.value);
        const prevVal = prev ? Number(prev.value) : null;
        const change = prevVal === null ? null : latestVal - prevVal;
        return {
          series_id: seriesId,
          title: meta.title,
          units: meta.units,
          frequency: meta.frequency,
          latest_value: latestVal,
          latest_date: latest.date,
          previous_value: prevVal,
          change,
          change_pct: prevVal ? ((latestVal - prevVal) / prevVal) * 100 : null,
          source_url: `https://fred.stlouisfed.org/series/${seriesId}`,
        };
      });
    }, `fred:${seriesId}`);
  },
  citation: (_, out) => ({ label: `FRED (${out.series_id})`, url: out.source_url }),
};
