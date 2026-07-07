-- Per-user free trial + one-time tweet extension (user decision 2026-07-07):
-- every tester gets a 7-day access window; when it lapses they can unlock ONE
-- extra week by tweeting about Pip and pasting the link in chat (the founder
-- verifies it manually), after that it's paid access. Idempotent.
--
-- access_until semantics: serving while now() < access_until. Set it to
-- 'infinity' for accounts that should never lapse (e.g. the founder):
--   update beta_testers set access_until = 'infinity' where platform_id = '<id>';
--
-- The volatile default backfills existing testers with a fresh 7 days from the
-- moment this migration runs — everyone already enrolled gets a full window.
alter table public.beta_testers
  add column if not exists access_until         timestamptz not null default (now() + interval '7 days'),
  add column if not exists extension_used       boolean not null default false,
  add column if not exists extension_tweet_url  text,
  add column if not exists extension_claimed_at timestamptz;
