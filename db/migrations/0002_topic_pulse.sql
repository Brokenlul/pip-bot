-- Anonymized cross-community intelligence layer. Idempotent — safe to re-run.
--
-- Privacy contract: this table holds ONLY a topic label, a day bucket, and a
-- count. No guild_id, no user_id, no raw question/answer text. It is the ONLY
-- data that is ever shared across communities. Per-guild memory (conversations,
-- semantic_cache) stays strictly guild-scoped — see 0001_init.sql.

create table if not exists public.topic_pulse (
  topic         text not null,
  bucket_date   date not null default (now() at time zone 'utc')::date,
  mentions      integer not null default 0,
  primary key (topic, bucket_date)
);

create index if not exists topic_pulse_date_idx
  on public.topic_pulse (bucket_date desc);

-- Server-only app: RLS on, no policies. Service role bypasses; anon REST gets nothing.
alter table public.topic_pulse enable row level security;

-- RPC: increment today's counter for a topic (anonymized aggregate write).
create or replace function public.bump_topic_pulse(p_topic text, p_count integer default 1)
returns void
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  insert into public.topic_pulse (topic, bucket_date, mentions)
  values (p_topic, (now() at time zone 'utc')::date, p_count)
  on conflict (topic, bucket_date)
  do update set mentions = public.topic_pulse.mentions + p_count;
end;
$$;

-- RPC: top topics across ALL communities over a trailing window.
create or replace function public.top_topics(p_days integer default 7, p_limit integer default 12)
returns table (topic text, mentions bigint)
language sql
stable
set search_path = public, pg_catalog
as $$
  select tp.topic, sum(tp.mentions)::bigint as mentions
  from public.topic_pulse tp
  where tp.bucket_date > (now() at time zone 'utc')::date - p_days
  group by tp.topic
  order by mentions desc, tp.topic
  limit p_limit
$$;
