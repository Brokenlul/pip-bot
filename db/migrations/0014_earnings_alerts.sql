-- Earnings alerts: "ping me before GOOGL reports". Reuses price_alerts rather
-- than adding a parallel table so list/cancel keep working over ONE id space —
-- a user asking "what alerts do I have" gets both kinds in one answer.
--
-- Price alerts are level-triggered (poller compares live price to a target).
-- Earnings alerts are time-triggered (poller compares now() to notify_at), so
-- target_price has to become nullable. Idempotent.

alter table public.price_alerts
  add column if not exists kind          text not null default 'price',
  add column if not exists notify_at     timestamptz,   -- when to fire (earnings)
  add column if not exists earnings_date date,          -- the reporting day itself
  add column if not exists earnings_when text,          -- 'before open' / 'after close'
  add column if not exists lead_minutes  integer;       -- how far ahead of the print

-- Older rows predate `kind` and are all price alerts.
update public.price_alerts set kind = 'price' where kind is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'price_alerts_kind_check'
  ) then
    alter table public.price_alerts
      add constraint price_alerts_kind_check check (kind in ('price', 'earnings'));
  end if;
end $$;

-- target_price is required for price alerts, meaningless for earnings ones.
alter table public.price_alerts alter column target_price drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'price_alerts_shape_check'
  ) then
    alter table public.price_alerts
      add constraint price_alerts_shape_check check (
        (kind = 'price'    and target_price is not null and direction is not null)
     or (kind = 'earnings' and notify_at    is not null and earnings_date is not null)
      );
  end if;
end $$;

-- direction is only meaningful for price alerts.
alter table public.price_alerts alter column direction drop not null;

-- The poller filters earnings rows on (active, notify_at).
create index if not exists price_alerts_notify_idx
  on public.price_alerts (active, notify_at)
  where kind = 'earnings';

-- One live earnings alert per user per symbol — re-asking updates rather than
-- stacking duplicate pushes for the same print.
create unique index if not exists price_alerts_earnings_uniq
  on public.price_alerts (platform, user_id, symbol)
  where kind = 'earnings' and active;
