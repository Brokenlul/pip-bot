-- Per-guild plan state for Server Pro. Server plans are enforced per GUILD
-- (the whole server shares the daily/monthly allowance), so the plan lives on
-- the guild row, not on the buyer's beta_testers row. A guild's free trial is
-- derived from guilds.created_at (first-seen) + 7 days; server_access_until is
-- the paid window once a Server Pro subscription is attached.
alter table public.guilds add column if not exists server_tier text;                 -- 'server-pro' | 'elite' | null
alter table public.guilds add column if not exists server_access_until timestamptz;  -- paid window; null = trial/none
alter table public.guilds add column if not exists server_subscription_id text;
alter table public.guilds add column if not exists server_subscription_provider text;
