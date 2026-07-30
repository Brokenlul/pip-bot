-- Fix: match_semantic_cache accepted p_min_similarity but never applied it —
-- the WHERE clause only filtered on guild_id/user_id/TTL, then returned
-- whatever was closest (LIMIT 1) even if that "closest" row was a totally
-- unrelated question with a real cosine similarity of e.g. 0.63 against a
-- configured floor of 0.92. Invisible for the semantic cache's whole life
-- because the caller also gated lookups on thread.length === 0 (see
-- 2026-07-30's "Fix semantic cache dead zone"), which meant the cache never
-- actually returned a row in practice. Removing that dead-zone gate exposed
-- this: Tervig asked an unrelated follow-up 7 min after a prior question and
-- got that prior answer served back verbatim, because it was the only (and
-- therefore "closest") candidate in the 10-minute TTL window.
--
-- Filtering on the <=> distance directly (rather than the derived
-- `1 - distance` similarity) lets Postgres use the ivfflat/hnsw distance
-- index for the comparison instead of computing it for every row first.
-- Idempotent — safe to re-run.

create or replace function public.match_semantic_cache(
  p_guild_id          text,
  p_user_id           text,
  p_question_embedding vector(512),
  p_min_similarity    float,
  p_ttl_seconds       integer
)
returns table (
  question    text,
  answer      text,
  sources     jsonb,
  cached_at   timestamptz,
  similarity  float
)
language sql
stable
set search_path = public, pg_catalog
as $$
  select
    sc.question,
    sc.answer,
    sc.sources,
    sc.created_at as cached_at,
    1 - (sc.question_embedding <=> p_question_embedding) as similarity
  from public.semantic_cache sc
  where sc.guild_id = p_guild_id
    and sc.user_id = p_user_id
    and sc.created_at > now() - make_interval(secs => p_ttl_seconds)
    and sc.question_embedding <=> p_question_embedding <= 1 - p_min_similarity
  order by sc.question_embedding <=> p_question_embedding
  limit 1
$$;
