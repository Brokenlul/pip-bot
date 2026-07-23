import { getDb } from '../memory/db.js';

/**
 * In-server frustration detection — keyword/regex only, no LLM cost, so it can
 * run on every server message rather than just ones addressed to Pip. This is
 * the only way to catch someone venting ("this bot is shit, it doesn't work")
 * without ever @-mentioning Pip, which today leaves zero trace anywhere.
 */
const TRIGGER = /\b(pip|bot)\b/i;
const NEGATIVE =
  /\b(shit|garbage|trash|sucks?|broken|doesn'?t\s*work|useless|dumb|stupid|hate|annoying|worthless|crap|awful|terrible|ignores?|scam|lying|wrong)\b/gi;

const MAX_EXCERPT_LEN = 300;

/** Matched negative terms (deduped, lowercased), or null if this message isn't
 *  a candidate frustration mention. Pure, no I/O — safe on every message. */
export function detectFrustration(text: string): string[] | null {
  if (!text || !TRIGGER.test(text)) return null;
  const matches = text.match(NEGATIVE);
  if (!matches || matches.length === 0) return null;
  return [...new Set(matches.map((m) => m.toLowerCase()))];
}

export interface SentimentEventRow {
  platform: string;
  guildId: string;
  userId: string;
  text: string;
  matchedTerms: string[];
}

/** Fire-and-forget durable record of a frustration mention. Never throws —
 *  this is an observability side-channel and must never affect the message
 *  handling it's called from. */
export async function logSentimentEvent(row: SentimentEventRow): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db.from('sentiment_event').insert({
      platform: row.platform,
      guild_id: row.guildId,
      user_id: row.userId,
      excerpt: row.text.slice(0, MAX_EXCERPT_LEN),
      matched_terms: row.matchedTerms,
    });
  } catch (e) {
    console.warn(`[sentiment] logSentimentEvent: ${(e as Error).message}`);
  }
}
