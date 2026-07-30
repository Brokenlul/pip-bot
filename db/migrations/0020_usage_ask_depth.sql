-- Tags each usage_log row with the depth tier (simple/standard/deep) the
-- answer was classified into (src/core/route.ts classifyDepth), used both to
-- pick max_tokens per turn (2026-07-30 latency fix — output token count turned
-- out to be the dominant cost/latency driver, not tool round-trips: a near-
-- linear relationship, 6s avg at <200 output tokens vs 51s avg at ~1900) and
-- to let the admin dashboard track the <10s/$0.06 targets against simple/
-- standard traffic only, separately from genuinely deep reads (a scan, a
-- thesis stress-test) which legitimately need a longer answer.
-- Idempotent — safe to re-run.
alter table public.usage_log add column if not exists ask_depth text;

create index if not exists usage_log_ask_depth_created_idx
  on public.usage_log (ask_depth, created_at desc);
