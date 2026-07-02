import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { getConfig } from '../config.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';

/**
 * Financial Modeling Prep — full line-item financial statements (the deep
 * layer beyond Finnhub's summarized metrics). Gated on FMP_API_KEY.
 * Free tier: ~5 years of annual/quarterly income, balance, cash-flow.
 * Docs: https://site.financialmodelingprep.com/developer/docs
 */

const StatementSchema = z.object({
  symbol: z.string().min(1).describe('Stock ticker, e.g. "AAPL", "NVDA".'),
  statement: z
    .enum(['income', 'balance', 'cashflow'])
    .optional()
    .describe('Which statement: income (default), balance, or cashflow.'),
  period: z.enum(['annual', 'quarter']).optional().describe('annual (default) or quarter.'),
});
type StatementInput = z.infer<typeof StatementSchema>;

interface Period {
  date: string;
  period: string;
  [k: string]: unknown;
}
interface StatementOut {
  symbol: string;
  statement: string;
  period: string;
  currency: string | null;
  periods: Record<string, unknown>[];
  source_url: string;
}

const ENDPOINT: Record<string, string> = {
  income: 'income-statement',
  balance: 'balance-sheet-statement',
  cashflow: 'cash-flow-statement',
};

// Key line items to surface per statement (keeps payloads tight + readable).
const FIELDS: Record<string, string[]> = {
  income: [
    'revenue', 'costOfRevenue', 'grossProfit', 'grossProfitRatio', 'operatingExpenses',
    'operatingIncome', 'operatingIncomeRatio', 'ebitda', 'netIncome', 'netIncomeRatio', 'eps', 'epsdiluted',
  ],
  balance: [
    'cashAndCashEquivalents', 'shortTermInvestments', 'totalCurrentAssets', 'totalAssets',
    'totalCurrentLiabilities', 'totalDebt', 'netDebt', 'totalLiabilities', 'totalStockholdersEquity',
  ],
  cashflow: [
    'netIncome', 'operatingCashFlow', 'capitalExpenditure', 'freeCashFlow',
    'dividendsPaid', 'commonStockRepurchased', 'netChangeInCash',
  ],
};

const cache = makeCache<StatementOut>(300_000); // 5 min

export const financialStatementsTool: Tool<StatementInput, StatementOut> = {
  name: 'equity_financial_statements',
  description:
    'Full line-item financial statements for a listed company by ticker — income statement (revenue, gross/operating income, EBITDA, net income, EPS), balance sheet (cash, debt, assets, equity), or cash-flow (operating CF, capex, free cash flow, buybacks). Returns the last few annual or quarterly periods so you can read the trend. Use when a fundamentals question needs actual statement figures, not just ratios.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', description: 'Stock ticker (e.g. "AAPL").' },
      statement: { type: 'string', enum: ['income', 'balance', 'cashflow'], description: 'Which statement.' },
      period: { type: 'string', enum: ['annual', 'quarter'], description: 'annual or quarter.' },
    },
    required: ['symbol'],
  },
  validate: zValidator(StatementSchema),
  execute: async (input) => {
    const key = getConfig().FMP_API_KEY;
    if (!key) throw new Error('FMP_API_KEY not set');
    const symbol = input.symbol.trim().toUpperCase().replace(/^\$/, '');
    const statement = input.statement ?? 'income';
    const period = input.period ?? 'annual';
    const cacheKey = `${symbol}:${statement}:${period}`;
    return withRetry(async () => {
      const hit = cache.get(cacheKey);
      if (hit) return hit;
      const url = `https://financialmodelingprep.com/api/v3/${ENDPOINT[statement]}/${symbol}?period=${period}&limit=4&apikey=${key}`;
      const res = await fetchWithTimeout(url, {}, 12_000);
      if (res.status === 401 || res.status === 403) throw new Error(`fmp auth ${res.status} (check key/tier)`);
      if (!res.ok) throw new Error(`fmp ${statement} ${res.status}`);
      const rows = (await res.json()) as Period[];
      if (!Array.isArray(rows) || rows.length === 0) throw new Error(`No ${statement} statement for "${symbol}"`);

      const wanted = FIELDS[statement] ?? [];
      const periods = rows.map((row) => {
        const slim: Record<string, unknown> = { date: row.date, period: row.period };
        for (const f of wanted) if (row[f] !== undefined) slim[f] = row[f];
        return slim;
      });

      const out: StatementOut = {
        symbol,
        statement,
        period,
        currency: (rows[0]?.reportedCurrency as string) ?? null,
        periods,
        source_url: `https://financialmodelingprep.com/financial-statements/${symbol}`,
      };
      cache.set(cacheKey, out);
      return out;
    }, `fmp:${cacheKey}`);
  },
  citation: (_, out) => ({ label: `FMP ${out.statement} (${out.symbol})`, url: out.source_url }),
};
