-- End-to-end funnel attribution (2026-07-22). Until now the site could see a
-- CTA click and the bot could see a first message, but nothing joined them: a
-- visitor is an anonymous localStorage id, a user is a platform snowflake. The
-- funnel therefore stopped dead at "clicked through to Pip" and we could not
-- tell a bounce at Discord's install screen from someone who arrived and was
-- turned away.
--
-- The join is a one-time random token minted in the browser at click time,
-- carried through the platform's own handoff, and claimed on arrival:
--   telegram    -> t.me/pipinvestbot?start=<token>  (payload lands in /start)
--   discord_bot -> oauth2/authorize?state=<token>   (returned to our callback)
-- The community invite (discord.gg/...) accepts no per-visitor parameter, so
-- that path stays deliberately cohort-only. Do not add a fake token for it.
--
-- PRIVACY: this is a real change of posture from 0012. site_events on its own
-- identifies nobody; a claimed token links an anonymous visitor to a platform
-- account, which makes the pair personal data. privacy.html was updated in the
-- same change to say so. Tokens are single-use and carry no personal data
-- themselves — they are random and meaningless until claimed.
--
-- Idempotent.

create table if not exists public.attribution_claims (
  token        text primary key,          -- random, minted client-side at click
  visitor_id   text,                      -- the anonymous site visitor
  intent       text not null,             -- 'telegram' | 'discord_bot'
  minted_at    timestamptz,               -- click time, copied from site_events
  claimed_at   timestamptz not null default now(),
  platform     text,                      -- 'telegram' | 'discord'
  platform_id  text,                      -- telegram user id (null for installs)
  guild_id     text,                      -- discord guild the bot landed in
  meta         jsonb not null default '{}'::jsonb
);

create index if not exists attribution_visitor_idx  on public.attribution_claims (visitor_id);
create index if not exists attribution_platform_idx on public.attribution_claims (platform, platform_id);
create index if not exists attribution_guild_idx    on public.attribution_claims (guild_id);
create index if not exists attribution_claimed_idx  on public.attribution_claims (claimed_at desc);

-- Server-only, same contract as site_events: RLS on with no policies. The
-- service role bypasses it; the anon REST key gets nothing.
alter table public.attribution_claims enable row level security;

-- Installs are currently invisible: guilds rows are written by ensureGuild on
-- the FIRST MESSAGE, so a server that adds Pip and never mentions it leaves no
-- trace at all. GuildCreate/GuildDelete now stamp these instead.
alter table public.guilds add column if not exists installed_at timestamptz;
alter table public.guilds add column if not exists removed_at   timestamptz;

-- Pip does NOT announce itself when it lands in a server: an unprompted post
-- into someone else's channel the moment you install a bot is noise. It waits,
-- and only if nobody has pinged it after a grace period does it introduce
-- itself once, in the most conversational channel it can post to.
-- greeted_at is stamped either way — including when the server pinged Pip on
-- its own, which retires the pending greeting so it can never fire later.
alter table public.guilds add column if not exists greeted_at timestamptz;

-- CRM labels. Keyed on (platform, platform_id) rather than hanging off
-- beta_testers because a LEAD is not necessarily a tester: someone who joins
-- the community server and never messages has an attribution_claims row and no
-- beta_testers row at all, and those are exactly the people worth tagging.
create table if not exists public.person_labels (
  platform    text not null,
  platform_id text not null,
  labels      text[] not null default '{}',
  note        text,
  updated_at  timestamptz not null default now(),
  primary key (platform, platform_id)
);
create index if not exists person_labels_labels_idx on public.person_labels using gin (labels);
alter table public.person_labels enable row level security;
