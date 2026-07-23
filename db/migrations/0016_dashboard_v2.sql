-- Dashboard v2: guild CRM labels, bot heartbeat, feedback->conversation
-- linkage, and in-server frustration-mention tracking. Idempotent.

-- Guild-level CRM labels, mirrors person_labels but keyed on guild id.
create table if not exists public.guild_labels (
  guild_id   text primary key references public.guilds(id) on delete cascade,
  labels     text[] not null default '{}',
  note       text,
  updated_at timestamptz not null default now()
);
alter table public.guild_labels enable row level security;

-- One row per platform adapter, refreshed on ready + on an interval, so the
-- dashboard can show real online/offline instead of inferring it from traffic.
create table if not exists public.bot_heartbeat (
  platform   text primary key,
  last_seen  timestamptz not null default now()
);
alter table public.bot_heartbeat enable row level security;

-- Links a persisted answer to the message id it was actually sent as, so a
-- later thumbs-down (feedback.message_id) can be traced back to the real
-- question/answer instead of just guild/user/time metadata.
alter table public.conversations add column if not exists message_id text;
create index if not exists conversations_message_id_idx on public.conversations(message_id);

-- In-server frustration mentions that never @-mention Pip (keyword/regex
-- match only, no LLM cost — see src/beta/sentiment.ts).
create table if not exists public.sentiment_event (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  platform      text not null,
  guild_id      text not null,
  user_id       text not null,
  excerpt       text,
  matched_terms text[]
);
create index if not exists sentiment_event_created_at_idx on public.sentiment_event(created_at desc);
create index if not exists sentiment_event_guild_idx on public.sentiment_event(guild_id, created_at desc);
alter table public.sentiment_event enable row level security;
