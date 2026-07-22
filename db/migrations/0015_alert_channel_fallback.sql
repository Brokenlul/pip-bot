-- A push alert only reaches the user if their DMs are open to the bot. When a
-- DM fails (DMs closed, blocked the bot), the alert previously just stayed
-- active and retried the same DM forever, silent to the user. This lets the
-- poller fall back to tagging them in the channel the alert was set from.
-- Nullable and best-effort: older rows and DM-originated requests have none,
-- and the fallback is skipped (not an error) when it's absent. Idempotent.

alter table public.price_alerts
  add column if not exists channel_id text;
