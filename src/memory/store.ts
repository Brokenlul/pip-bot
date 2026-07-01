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

export async function lookupCache(
  guildId: string,
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
  const { data, error } = await db.rpc('match_semantic_cache', {
    p_guild_id: guildId,
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
): Promise<RecentQuestion[]> {
  const db = getDb();
  if (!db) return [];
  const { data, error } = await db
    .from('conversations')
    .select('question, answer, user_id, created_at')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: false })
    .limit(limit);
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
