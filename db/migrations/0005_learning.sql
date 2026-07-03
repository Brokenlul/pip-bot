-- Per-trader learning profile: a compact, evolving picture of each user that
-- Pip injects into its prompt to tailor answers over time. Distilled from the
-- user's OWN history + 👍/👎 reactions. Idempotent — safe to re-run.
--
-- Privacy: scoped per (guild_id, user_id) exactly like conversation memory. A
-- trader's profile is only ever used to serve that same trader — never shared.
create table if not exists public.user_profiles (
  guild_id   text not null,
  user_id    text not null,
  profile    text not null default '',
  updated_at timestamptz not null default now(),
  primary key (guild_id, user_id)
);

alter table public.user_profiles enable row level security;
