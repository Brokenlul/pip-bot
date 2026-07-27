-- Refer & earn (2026-07-27). A referrer earns cash when someone they referred
-- becomes a PAYING subscriber, on a cumulative milestone ladder:
--   1 ref = $5 total, 3 = $20, 5 = $40, 9 = $70, 25 = $150.
--
-- The ladder is cumulative and never exceeds what those referrals actually paid.
-- That is the whole anti-abuse design: a flat bounty of $20 against a $12/mo
-- plan would let anyone pay $12, refer themselves and walk away +$8. Every rung
-- here loses money for a self-referrer, and the invariant
--   cumulative_reward(N) < N * cheapest_monthly_plan
-- is enforced by a test, not by good intentions. See src/beta/referral-ladder.ts.
--
-- Rewards are per MILESTONE, not per referral, so they need their own table:
-- referrals tracks people, referral_payouts tracks money.
--
-- Idempotent.

alter table public.beta_testers
  add column if not exists referral_code   text,
  add column if not exists payout_method   text,   -- 'usdc' | 'upi' | 'paypal'
  add column if not exists payout_address  text;

-- Partial unique: most rows have no code yet, and NULLs must not collide.
create unique index if not exists beta_testers_referral_code_idx
  on public.beta_testers (referral_code) where referral_code is not null;

-- One row per referred PERSON.
create table if not exists public.referrals (
  id                    bigserial primary key,
  code                  text not null,
  referrer_platform     text not null,
  referrer_platform_id  text not null,
  referred_platform     text not null,
  referred_platform_id  text not null,
  visitor_id            text,
  referred_at           timestamptz not null default now(),
  converted_at          timestamptz,   -- became a paying subscriber
  qualified_at          timestamptz,   -- survived the holdback; now counts
  subscription_provider text,
  subscription_id       text,
  -- pending -> converted -> qualified, or void (self-referral, refund, abuse)
  status                text not null default 'pending',
  meta                  jsonb not null default '{}'::jsonb
);

-- A person can be referred exactly ONCE, ever. This is the primary fraud guard
-- and it lives in the database on purpose: application logic races, a unique
-- index does not.
create unique index if not exists referrals_referred_once_idx
  on public.referrals (referred_platform, referred_platform_id);
create index if not exists referrals_referrer_idx
  on public.referrals (referrer_platform, referrer_platform_id);
create index if not exists referrals_status_idx on public.referrals (status);
create index if not exists referrals_code_idx on public.referrals (code);

-- One row per milestone REACHED. cumulative_usd is the ladder value at that
-- rung; topup_usd is what actually gets sent (cumulative minus everything
-- already recorded for this referrer).
create table if not exists public.referral_payouts (
  id                   bigserial primary key,
  referrer_platform    text not null,
  referrer_platform_id text not null,
  milestone_refs       int  not null,           -- 1 | 3 | 5 | 9 | 25
  cumulative_usd       numeric(10,2) not null,
  topup_usd            numeric(10,2) not null,
  reached_at           timestamptz not null default now(),
  -- payable -> paid, or held (over the monthly cap, needs a human) / void
  status               text not null default 'payable',
  paid_at              timestamptz,
  payout_ref           text,
  note                 text
);

-- A milestone can only ever be paid once per referrer. Makes double-payment
-- impossible even if settlement runs twice concurrently (it is called from both
-- the payment webhook and the bot, by design).
create unique index if not exists referral_payouts_once_idx
  on public.referral_payouts (referrer_platform, referrer_platform_id, milestone_refs);
create index if not exists referral_payouts_status_idx
  on public.referral_payouts (status, reached_at desc);

-- Server-only, same contract as site_events / attribution_claims: RLS on with
-- no policies. The service role bypasses it; the anon REST key gets nothing.
-- This matters more here than elsewhere — these rows decide who gets paid.
alter table public.referrals        enable row level security;
alter table public.referral_payouts enable row level security;
