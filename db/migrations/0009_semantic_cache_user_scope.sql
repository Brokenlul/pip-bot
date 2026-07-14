-- Fix: the semantic cache was scoped to guild_id only, with no per-user
-- boundary. That meant one user's cached answer — including one shaped by
-- something false THEY asserted in their question — could be served to a
-- DIFFERENT user in the same guild who happened to ask something semantically
-- similar within the cache TTL. Cross-guild leakage was never possible
-- (guild_id was always enforced); this closes the same-guild, cross-user gap.
-- Idempotent — safe to re-run.

alter table public.semantic_cache add column if not exists user_id text;

create index if not exists semantic_cache_guild_user_created_idx
  on public.semantic_cache (guild_id, user_id, created_at desc);

-- Changing the parameter list requires a drop first — CREATE OR REPLACE
-- can't alter an existing function's signature, it would just leave the old
-- 4-arg overload dangling alongside this one.
drop function if exists public.match_semantic_cache(text, vector(512), float, integer);

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
  order by sc.question_embedding <=> p_question_embedding
  limit 1
$$;
