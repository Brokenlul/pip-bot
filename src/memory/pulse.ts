import { getDb } from './db.js';

/**
 * Anonymized cross-community intelligence.
 *
 * The ONLY thing shared across servers/DMs is an aggregate count of which
 * *topics* (assets + macro themes) people are asking about — never raw text,
 * never which community or user. Per-guild memory stays siloed (see store.ts);
 * this layer gives Pip situational awareness ("SOL and funding are hot right
 * now across communities") without leaking anyone's specifics.
 */

// Distinctive tickers — safe to match case-insensitively in natural language.
const SAFE_TICKERS = [
  'BTC', 'BITCOIN', 'ETH', 'ETHEREUM', 'SOL', 'SOLANA', 'XRP', 'BNB', 'DOGE',
  'AVAX', 'MATIC', 'SUI', 'SEI', 'TIA', 'INJ', 'LTC', 'BCH', 'TRX',
  'PEPE', 'BONK', 'SHIB', 'FTM', 'RNDR', 'WLD',
] as const;

// Collide with common English words / names — only count when UPPERCASE or $-prefixed.
const AMBIGUOUS_TICKERS = [
  'OP', 'ARB', 'TON', 'NEAR', 'LINK', 'SAND', 'GAS', 'WIF',
  'DOT', 'APT', 'ATOM', 'HYPE', 'ADA',
] as const;

// Canonicalize aliases → a single topic label.
const CANON: Record<string, string> = {
  BITCOIN: 'BTC',
  ETHEREUM: 'ETH',
  SOLANA: 'SOL',
  MICROSTRATEGY: 'MSTR',
};

// Macro / structural themes → canonical topic label. Keys are case-insensitive substrings.
const THEMES: Array<[RegExp, string]> = [
  [/\bfunding\b/i, 'funding'],
  [/\b(open interest|\boi\b)/i, 'open-interest'],
  [/\bliquidat/i, 'liquidations'],
  [/\bcpi\b/i, 'cpi'],
  [/\bpce\b/i, 'pce'],
  [/\b(fomc|fed|powell)\b/i, 'fomc'],
  [/\brate cut|rate hike|\bcut\b/i, 'rates'],
  [/\betf\b/i, 'etf'],
  [/\b(unemployment|jobs|nfp|payroll)\b/i, 'jobs'],
  [/\bgdp\b/i, 'gdp'],
  [/\byield|treasur|10y\b/i, 'yields'],
  [/\brecession\b/i, 'recession'],
  [/\bhalving\b/i, 'halving'],
  [/\bairdrop\b/i, 'airdrop'],
  [/\bunlock\b/i, 'unlock'],
  [/\b(mstr|microstrategy)\b/i, 'MSTR'],
];

/** Pull a small set of canonical topic labels out of a question. Pure + side-effect free. */
export function extractTopics(text: string): string[] {
  const topics = new Set<string>();

  // $CASHTAGS — always count.
  for (const m of text.matchAll(/\$([A-Za-z]{2,6})\b/g)) {
    if (!m[1]) continue;
    const t = m[1].toUpperCase();
    topics.add(CANON[t] ?? t);
  }

  // Safe tickers, case-insensitive word boundary.
  for (const t of SAFE_TICKERS) {
    if (new RegExp(`\\b${t}\\b`, 'i').test(text)) topics.add(CANON[t] ?? t);
  }

  // Ambiguous tickers only when uppercase (word boundary, case-sensitive).
  for (const t of AMBIGUOUS_TICKERS) {
    if (new RegExp(`\\b${t}\\b`).test(text)) topics.add(CANON[t] ?? t);
  }

  // Themes.
  for (const [re, label] of THEMES) {
    if (re.test(text)) topics.add(label);
  }

  // Cap so one rambling message can't skew the pulse.
  return [...topics].slice(0, 8);
}

/** Fire-and-forget: bump the anonymized global counters for a question. Never throws. */
export async function recordTopics(text: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  const topics = extractTopics(text);
  if (topics.length === 0) return;
  await Promise.all(
    topics.map((topic) =>
      db
        .rpc('bump_topic_pulse', { p_topic: topic, p_count: 1 })
        .then(({ error }) => {
          if (error) console.warn(`[pulse] bump ${topic}: ${error.message}`);
        }),
    ),
  ).catch((e) => console.warn(`[pulse] recordTopics: ${(e as Error).message}`));
}

export interface TrendingTopic {
  topic: string;
  mentions: number;
}

/** Top topics across ALL communities over a trailing window. Aggregates only. */
export async function trendingTopics(days = 7, limit = 12): Promise<TrendingTopic[]> {
  const db = getDb();
  if (!db) return [];
  const { data, error } = await db.rpc('top_topics', { p_days: days, p_limit: limit });
  if (error) {
    console.warn(`[pulse] top_topics: ${error.message}`);
    return [];
  }
  return (data as Array<{ topic: string; mentions: number }> | null ?? []).map((r) => ({
    topic: r.topic,
    mentions: Number(r.mentions),
  }));
}
