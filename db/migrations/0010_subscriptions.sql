-- 0010_subscriptions.sql — paid-access columns on beta_testers.
--
-- Written by the pip-site payment webhooks (Dodo Payments / Loop Crypto) when a
-- checkout succeeds, and merged onto the buyer's numeric row when they next
-- message Pip (claimHandleRow in src/beta/guardrails.ts). Access itself is still
-- gated by access_until; these columns are for lifecycle + support.
--
-- Idempotent: safe to re-run.

alter table beta_testers add column if not exists tier text;
alter table beta_testers add column if not exists subscription_provider text;
alter table beta_testers add column if not exists subscription_id text;
alter table beta_testers add column if not exists subscription_status text;
