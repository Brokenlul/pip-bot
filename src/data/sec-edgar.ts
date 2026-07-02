import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';

/**
 * SEC EDGAR — keyless official US filings. Its unique value is the filing
 * feed: 10-K/10-Q (financial reports), 8-K (material events), and Form 4
 * (insider buys/sells) with dates and links. Ground-truth events that no
 * price feed surfaces. Requires a descriptive User-Agent per SEC policy.
 * Docs: https://www.sec.gov/os/accessing-edgar-data
 */

const UA = { 'User-Agent': 'Paul-Bot market-research bot (contact via Discord)' };

// ticker -> { cik (10-digit), title }
interface TickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}
const tickerMapCache = makeCache<Map<string, { cik: string; title: string }>>(86_400_000); // 1 day

async function tickerMap(): Promise<Map<string, { cik: string; title: string }>> {
  const hit = tickerMapCache.get('map');
  if (hit) return hit;
  const res = await fetchWithTimeout('https://www.sec.gov/files/company_tickers.json', { headers: UA }, 12_000);
  if (!res.ok) throw new Error(`sec tickers ${res.status}`);
  const raw = (await res.json()) as Record<string, TickerRow>;
  const map = new Map<string, { cik: string; title: string }>();
  for (const row of Object.values(raw)) {
    map.set(row.ticker.toUpperCase(), { cik: String(row.cik_str).padStart(10, '0'), title: row.title });
  }
  tickerMapCache.set('map', map);
  return map;
}

const SymbolSchema = z.object({
  symbol: z.string().min(1).describe('Stock ticker, e.g. "AAPL", "NVDA", "MSTR".'),
  form: z
    .string()
    .optional()
    .describe('Optional filing-type filter, e.g. "8-K", "10-Q", "10-K", "4". Omit for the latest across all types.'),
});
type SymbolInput = z.infer<typeof SymbolSchema>;

interface Filing {
  form: string;
  filed: string;
  description: string | null;
  url: string;
}
interface FilingsOut {
  symbol: string;
  company: string | null;
  cik: string;
  filings: Filing[];
  source_url: string;
}

interface SubmissionsResp {
  name?: string;
  filings?: {
    recent?: {
      accessionNumber?: string[];
      filingDate?: string[];
      form?: string[];
      primaryDocument?: string[];
      primaryDocDescription?: string[];
    };
  };
}

export const secFilingsTool: Tool<SymbolInput, FilingsOut> = {
  name: 'sec_filings',
  description:
    "Recent SEC filings for a US-listed company by ticker: 10-K / 10-Q (financial reports), 8-K (material events like guidance, M&A, executive changes), and Form 4 (insider buys/sells), each with filing date and a direct link. Use for \"any recent filings / news from <company>\", material events, insider activity, or to ground a fundamentals discussion in official disclosures. Optional form filter (e.g. \"8-K\").",
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Stock ticker (e.g. "AAPL").' },
      form: { type: 'string', description: 'Optional filing type filter, e.g. "8-K", "10-Q", "10-K", "4".' },
    },
    required: ['symbol'],
  },
  validate: zValidator(SymbolSchema),
  execute: async (input) => {
    const symbol = input.symbol.trim().toUpperCase().replace(/^\$/, '');
    const formFilter = input.form?.trim().toUpperCase();
    return withRetry(async () => {
      const map = await tickerMap();
      const entry = map.get(symbol);
      if (!entry) throw new Error(`No SEC CIK for ticker "${symbol}" (US-listed only)`);

      const res = await fetchWithTimeout(
        `https://data.sec.gov/submissions/CIK${entry.cik}.json`,
        { headers: UA },
        12_000,
      );
      if (!res.ok) throw new Error(`sec submissions ${res.status}`);
      const data = (await res.json()) as SubmissionsResp;
      const r = data.filings?.recent;
      const cikNoPad = String(Number(entry.cik));

      const filings: Filing[] = [];
      const forms = r?.form ?? [];
      for (let i = 0; i < forms.length && filings.length < 8; i++) {
        const form = forms[i] ?? '';
        if (formFilter && form.toUpperCase() !== formFilter) continue;
        const acc = (r?.accessionNumber?.[i] ?? '').replace(/-/g, '');
        const doc = r?.primaryDocument?.[i] ?? '';
        filings.push({
          form,
          filed: r?.filingDate?.[i] ?? '',
          description: r?.primaryDocDescription?.[i] || null,
          url: acc && doc ? `https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${acc}/${doc}` : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${entry.cik}`,
        });
      }

      return {
        symbol,
        company: data.name ?? entry.title,
        cik: entry.cik,
        filings,
        source_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${entry.cik}&type=${formFilter ?? ''}`,
      };
    }, `sec:${symbol}`);
  },
  citation: (_, out) => ({ label: `SEC EDGAR (${out.symbol})`, url: out.source_url }),
};
