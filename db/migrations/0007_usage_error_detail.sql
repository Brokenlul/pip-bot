-- Diagnostic detail for a failed turn (error kind/status/type/message, or
-- "timeout"), so failures are queryable from Supabase instead of only living
-- in Railway's ephemeral console log. Idempotent — safe to re-run.
alter table public.usage_log add column if not exists error_detail text;
