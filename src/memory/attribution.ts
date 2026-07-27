/*
 * Funnel attribution — joins an anonymous site visitor to the platform account
 * they turned into.
 *
 * The site mints a one-time random token at CTA-click time and carries it
 * through the platform's own handoff (Telegram deep-link payload, Discord OAuth
 * `state`). Whichever side sees the token on arrival claims it here. See
 * db/migrations/0013_attribution.sql.
 *
 * Everything in here is best-effort: attribution must never be able to break or
 * delay a real reply, so callers fire and forget.
 */
import { getDb } from './db.js';
import { recordReferral } from './referral.js';

// Exactly what assets/track.js mints. Anything else is noise — a user typing
// /start with random text, or someone poking at the deep link.
const TOKEN_RE = /^[a-f0-9]{32}$/;

export interface ClaimArgs {
  token: string;
  intent: 'telegram' | 'discord_bot';
  platform: string;
  platformId?: string;
  guildId?: string;
}

export function isAttributionToken(v: string): boolean {
  return TOKEN_RE.test(v);
}

/**
 * Record someone joining the main Pip community server. Every joiner is a lead,
 * and this is the only signal we get for that path: a discord.gg invite carries
 * no per-visitor parameter, so a community join can never be traced back to a
 * site visitor the way the Telegram and add-bot handoffs can.
 *
 * The token here is deterministic rather than random (the one exception to the
 * rule in 0013_attribution.sql) precisely so a rejoin overwrites instead of
 * inserting a duplicate lead.
 */
export async function recordCommunityJoin(
  guildId: string,
  userId: string,
  userName?: string,
): Promise<void> {
  const db = getDb();
  if (!db) return;
  await db
    .from('attribution_claims')
    .upsert(
      {
        token: `join:${guildId}:${userId}`,
        visitor_id: null, // unknowable for this path, by design
        intent: 'discord_community',
        platform: 'discord',
        platform_id: userId,
        guild_id: guildId,
        meta: userName ? { name: userName } : {},
      },
      { onConflict: 'token' },
    )
    .throwOnError();
}

export async function claimAttribution(args: ClaimArgs): Promise<void> {
  if (!isAttributionToken(args.token)) return;
  const db = getDb();
  if (!db) return;

  // Look up the click that minted the token so the visitor id (and the moment
  // they clicked) carry across. No match just means the beacon was lost or the
  // token is bogus — still worth recording the arrival itself.
  // `meta` comes along for the ride so a refer-&-earn code stamped onto the
  // click (assets/track.js) reaches the bot with no extra handoff plumbing —
  // the Telegram deep-link payload is already full, and this row is the only
  // other thing that crosses the boundary.
  const { data } = await db
    .from('site_events')
    .select('visitor_id, created_at, meta')
    .eq('event', 'click')
    .eq('meta->>token', args.token)
    .limit(1);
  const click = data?.[0] as
    | { visitor_id: string; created_at: string; meta: { ref?: string } | null }
    | undefined;

  await db
    .from('attribution_claims')
    .upsert(
      {
        token: args.token,
        visitor_id: click?.visitor_id ?? null,
        intent: args.intent,
        minted_at: click?.created_at ?? null,
        platform: args.platform,
        platform_id: args.platformId ?? null,
        guild_id: args.guildId ?? null,
      },
      { onConflict: 'token' },
    )
    .throwOnError();

  console.log(
    `[attribution] claimed ${args.intent} token for ${args.platform}:${args.platformId ?? args.guildId}` +
      (click ? ` (visitor ${click.visitor_id.slice(0, 8)}…)` : ' (no matching click)'),
  );

  // Refer & earn: this is the automatic path. A person who arrived via someone
  // else's /r/<code> link gets attached to that referrer here, without either
  // of them doing anything. Best-effort — a failed referral must never affect
  // the arrival itself, which is the whole point of this function.
  const ref = click?.meta?.ref;
  if (ref && args.platformId) {
    await recordReferral({
      code: ref,
      referredPlatform: args.platform,
      referredPlatformId: args.platformId,
      visitorId: click?.visitor_id ?? null,
    }).catch((e) => console.warn(`[attribution] referral: ${(e as Error).message}`));
  }
}
