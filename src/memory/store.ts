import { getDb } from './db.js';
import { embed } from './embeddings.js';
import { recordTopics } from './pulse.js';
import { getConfig, memoryEnabled, embeddingsEnabled } from '../config.js';

/**
 * Memory + semantic cache. The moat habit:
 *   - `lookupCache` runs BEFORE the agent loop.
 *   - `persistQA` runs AFTER every answer.
 * Both are guild-scoped — guild memory never leaks to another guild.
 *
 * All functions are no-ops when Supabase isn't configured, so M1/M2/M3
 * can be smoke-tested without a DB. Memory turns on at M4.
 */

export interface CachedAnswer {
  question: string;
  answer: string;
  sources: Array<{ label: string; url?: string }>;
  cachedAt: Date;
  similarity: number;
}

export interface RecentQuestion {
  question: string;
  answer: string;
  askedAt: Date;
  userId: string;
}

export async function ensureGuild(guildId: string, guildName?: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .from('guilds')
    .upsert({ id: guildId, name: guildName ?? null }, { onConflict: 'id' })
    .throwOnError();
}

/**
 * Stamp the moment Pip was added to a server. ensureGuild only ever fires on a
 * first MESSAGE, so without this an install that nobody follows up on is
 * invisible: we could not tell "added and ignored" from "never added".
 */
export async function markGuildInstalled(guildId: string, guildName?: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .from('guilds')
    .upsert(
      {
        id: guildId,
        name: guildName ?? null,
        installed_at: new Date().toISOString(),
        removed_at: null, // a re-add clears an earlier removal
      },
      { onConflict: 'id' },
    )
    .throwOnError();
}

/** Pip was kicked or the server was deleted. Keeps the row for funnel history. */
export async function markGuildRemoved(guildId: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .from('guilds')
    .update({ removed_at: new Date().toISOString() })
    .eq('id', guildId)
    .throwOnError();
}

export async function lookupCache(
  guildId: string,
  userId: string,
  question: string,
): Promise<CachedAnswer | null> {
  const db = getDb();
  if (!db) return null;
  // No embedder → no semantic cache. Persistence + recall still work.
  if (!embeddingsEnabled()) return null;
  const cfg = getConfig();
  let vec: number[];
  try {
    vec = await embed(question);
  } catch (e) {
    console.warn(`[memory] embed failed during cache lookup: ${(e as Error).message}`);
    return null;
  }
  // Scoped to (guild_id, user_id) — a cache hit must be THIS user's own prior
  // answer, never another trader's in the same server. Closes a real
  // cross-user contamination path: one user's answer (possibly shaped by
  // something false they asserted) could otherwise be served to someone else
  // asking a semantically similar question minutes later.
  const { data, error } = await db.rpc('match_semantic_cache', {
    p_guild_id: guildId,
    p_user_id: userId,
    p_question_embedding: vec,
    p_min_similarity: cfg.SEMANTIC_CACHE_SIMILARITY,
    p_ttl_seconds: cfg.SEMANTIC_CACHE_TTL_SECONDS,
  });
  if (error) {
    console.warn(`[memory] match_semantic_cache: ${error.message}`);
    return null;
  }
  const row = (data as Array<{
    question: string;
    answer: string;
    sources: Array<{ label: string; url?: string }> | null;
    cached_at: string;
    similarity: number;
  }> | null)?.[0];
  if (!row) return null;
  return {
    question: row.question,
    answer: row.answer,
    sources: row.sources ?? [],
    cachedAt: new Date(row.cached_at),
    similarity: row.similarity,
  };
}

export async function persistQA(opts: {
  guildId: string;
  userId: string;
  question: string;
  answer: string;
  sources: Array<{ label: string; url?: string }>;
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  let vec: number[] | null = null;
  if (embeddingsEnabled()) {
    try {
      vec = await embed(opts.question);
    } catch (e) {
      console.warn(`[memory] embed failed during persist: ${(e as Error).message}`);
    }
  }
  // 1. Append to conversations (memory of every Q&A — runs with or without embeddings)
  await db
    .from('conversations')
    .insert({
      guild_id: opts.guildId,
      user_id: opts.userId,
      question: opts.question,
      answer: opts.answer,
      sources: opts.sources,
      question_embedding: vec,
    })
    .throwOnError();

  // 2. Upsert into semantic cache (only if we have an embedding)
  if (vec) {
    await db
      .from('semantic_cache')
      .insert({
        guild_id: opts.guildId,
        user_id: opts.userId,
        question: opts.question,
        question_embedding: vec,
        answer: opts.answer,
        sources: opts.sources,
      })
      .throwOnError();
  }

  // 3. Anonymized global pulse — topic counts only, never raw text or guild id.
  //    Non-blocking and non-throwing so it can never break a persisted answer.
  void recordTopics(opts.question);
}

export async function recentQuestions(
  guildId: string,
  limit = 8,
  userId?: string,
): Promise<RecentQuestion[]> {
  const db = getDb();
  if (!db) return [];
  // Privacy: when a userId is given, recall is scoped to THAT trader's own
  // history — Pip never surfaces one trader's questions to another.
  let q = db
    .from('conversations')
    .select('question, answer, user_id, created_at')
    .eq('guild_id', guildId);
  if (userId) q = q.eq('user_id', userId);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(limit);
  if (error) {
    console.warn(`[memory] recentQuestions: ${error.message}`);
    return [];
  }
  return (data ?? []).map((r) => ({
    question: r.question,
    answer: r.answer,
    askedAt: new Date(r.created_at),
    userId: r.user_id,
  }));
}

export interface ThreadTurn {
  question: string;
  answer: string;
  askedAt: Date;
}

/**
 * Recent back-and-forth for ONE user in ONE chat, oldest-first — the material
 * for multi-turn continuity. Scoped to (guild_id, user_id) so a follow-up like
 * "any smart money in this?" threads to that user's own last exchanges, not the
 * whole server's. Bounded by a recency window so a stale conversation from days
 * ago isn't dragged in as "context" for an unrelated new question.
 */
export async function recentThread(
  guildId: string,
  userId: string,
  opts: { windowMinutes?: number; limit?: number } = {},
): Promise<ThreadTurn[]> {
  const db = getDb();
  if (!db) return [];
  const windowMinutes = opts.windowMinutes ?? 45;
  const limit = opts.limit ?? 6;
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const { data, error } = await db
    .from('conversations')
    .select('question, answer, created_at')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn(`[memory] recentThread: ${error.message}`);
    return [];
  }
  // Fetched newest-first (so LIMIT keeps the most recent); flip to chronological
  // for the transcript. Drop any row missing text — an empty content block is
  // rejected by the API and would sink the whole reply.
  return (data ?? [])
    .filter((r) => r.question?.trim() && r.answer?.trim())
    .map((r) => ({ question: r.question, answer: r.answer, askedAt: new Date(r.created_at) }))
    .reverse();
}

export async function incrementUsage(guildId: string): Promise<void> {
  const db = getDb();
  if (!db) return;
  const { error } = await db.rpc('increment_usage', { p_guild_id: guildId });
  if (error) {
    console.warn(`[memory] increment_usage: ${error.message}`);
  }
}

export function isMemoryOn(): boolean {
  return memoryEnabled();
}
