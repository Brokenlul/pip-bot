-- Paul-Bot v0 schema. Idempotent — safe to re-run.

create extension if not exists vector;

-- Server-only app: lock down public REST access. The service role bypasses RLS,
-- so the bot keeps working; anon REST traffic gets nothing.
-- (RLS-enabled-no-policy is intentional here — DO NOT add public policies.)

-- Guilds (one row per Discord guild seen)
create table if not exists public.guilds (
  id              text primary key,
  name            text,
  created_at      timestamptz not null default now()
);

-- Every Q&A persisted per-guild. This is the memory.
create table if not exists public.conversations (
  id                  bigserial primary key,
  guild_id            text not null references public.guilds(id) on delete cascade,
  user_id             text not null,
  question            text not null,
  answer              text not null,
  sources             jsonb not null default '[]'::jsonb,
  question_embedding  vector(512),
  created_at          timestamptz not null default now()
);

create index if not exists conversations_guild_created_idx
  on public.conversations (guild_id, created_at desc);

-- Semantic cache: serve near-identical recent questions without re-running tools/LLM.
create table if not exists public.semantic_cache (
  id                  bigserial primary key,
  guild_id            text not null references public.guilds(id) on delete cascade,
  question            text not null,
  question_embedding  vector(512) not null,
  answer              text not null,
  sources             jsonb not null default '[]'::jsonb,
  created_at          timestamptz not null default now()
);

create index if not exists semantic_cache_guild_created_idx
  on public.semantic_cache (guild_id, created_at desc);

-- pgvector ANN index for cache lookups. ivfflat with cosine.
create index if not exists semantic_cache_guild_embedding_idx
  on public.semantic_cache
  using ivfflat (question_embedding vector_cosine_ops)
  with (lists = 100);

-- Per-guild daily usage counter (no billing — just observability).
create table if not exists public.usage_daily (
  guild_id      text not null references public.guilds(id) on delete cascade,
  usage_date    date not null default (now() at time zone 'utc')::date,
  questions     integer not null default 0,
  primary key (guild_id, usage_date)
);

-- Enable RLS on all tables (no policies — server-only app uses the service role,
-- which bypasses RLS; anon REST gets nothing).
alter table public.guilds          enable row level security;
alter table public.conversations   enable row level security;
alter table public.semantic_cache  enable row level security;
alter table public.usage_daily     enable row level security;

-- RPC: find the best in-window cache hit for a guild.
create or replace function public.match_semantic_cache(
  p_guild_id          text,
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
    and sc.created_at > now() - make_interval(secs => p_ttl_seconds)
  order by sc.question_embedding <=> p_question_embedding
  limit 1
$$;

-- RPC: bump today's usage counter for a guild.
create or replace function public.increment_usage(p_guild_id text)
returns void
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  insert into public.usage_daily (guild_id, usage_date, questions)
  values (p_guild_id, (now() at time zone 'utc')::date, 1)
  on conflict (guild_id, usage_date)
  do update set questions = public.usage_daily.questions + 1;
end;
$$;
