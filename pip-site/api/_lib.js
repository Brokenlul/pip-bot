// Shared helpers for the pip payment webhooks (Dodo Payments + Loop Crypto).
// Runs on the Vercel Edge runtime: Web Crypto for HMAC, fetch for Supabase REST.
// No npm dependencies — keeps the static site build-free.

const enc = new TextEncoder();

// ---- encoding ---------------------------------------------------------------

function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

function toBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Constant-time string compare (avoids timing side-channels on the signature).
export function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- HMAC -------------------------------------------------------------------

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return new Uint8Array(sig);
}

/**
 * Verify a Standard Webhooks signature (Dodo Payments).
 * Signed content is `id.timestamp.body`; the secret is `whsec_<base64>`; the
 * header is a space-separated list of `v1,<base64sig>` tokens.
 */
export async function verifyStandardWebhook(headers, rawBody, secret) {
  const id = headers.get('webhook-id');
  const ts = headers.get('webhook-timestamp');
  const sigHeader = headers.get('webhook-signature');
  if (!id || !ts || !sigHeader || !secret) return false;

  // Reject stale deliveries (replay window: 5 minutes).
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;

  const keyBytes = secret.startsWith('whsec_')
    ? fromBase64(secret.slice(6))
    : enc.encode(secret);
  const expected = toBase64(await hmac(keyBytes, `${id}.${ts}.${rawBody}`));

  return sigHeader.split(' ').some((tok) => {
    const sig = tok.includes(',') ? tok.split(',')[1] : tok;
    return sig && safeEqual(sig, expected);
  });
}

/**
 * Verify a Loop Crypto webhook signature: HMAC-SHA256 over the raw body with
 * the shared secret. Loop's docs describe a hex digest; we also accept base64
 * and a `sha256=` prefix so a format nuance can't silently drop live events.
 */
export async function verifyLoopWebhook(headers, rawBody, secret) {
  const header = headers.get('loop-signature');
  if (!header || !secret) return false;
  const received = header.includes('=') ? header.split('=').pop() : header;
  const mac = await hmac(enc.encode(secret), rawBody);
  return safeEqual(received, toHex(mac)) || safeEqual(received, toBase64(mac));
}

/**
 * Verify a MoonPay Commerce (Helio) webhook.
 *
 * Helio delivers BOTH of these on every call, keyed by the same `sharedToken`
 * that its dashboard/API hands you once at webhook-creation time:
 *   - `Authorization: Bearer <sharedToken>`
 *   - `X-Signature: <hex HMAC-SHA256 of the RAW BODY>`  (no timestamp prefix)
 * Either env may hold that token; both are compared against both schemes so a
 * value in the "wrong" one still verifies.
 *
 * A 2026-07-24 live payment was lost because this function only understood
 * `Moonpay-Signature-V2: t=..,s=..` over `<ts>.<body>` — that is MoonPay's ramp
 * API scheme, which Commerce never sends. Six deliveries 401'd and the buyer got
 * no access. The V2 branch is kept (harmless, and covers a future migration),
 * but X-Signature is the one Commerce actually uses.
 *
 * Fails closed: with no env configured nothing can pass. Returns a reason so the
 * caller can log WHY a rejection happened without leaking secrets.
 */
export async function verifyMoonpayWebhook(headers, rawBody, { token, secret }) {
  const candidates = [token, secret].filter(Boolean);
  if (!candidates.length) return { ok: false, reason: 'no MOONPAY_WEBHOOK_TOKEN/SECRET configured' };

  // 1) Shared bearer token.
  const presented = (headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (presented && candidates.some((c) => safeEqual(presented, c))) return { ok: true, via: 'bearer' };

  // 2) X-Signature: HMAC-SHA256 over the raw body. Accept hex or base64, with or
  //    without a `sha256=` prefix, so an encoding nuance can't drop a live event.
  const xsig = (headers.get('x-signature') || headers.get('helio-signature') || '').trim();
  if (xsig) {
    const received = xsig.includes('=') && !xsig.endsWith('=') ? xsig.split('=').pop().trim() : xsig;
    for (const c of candidates) {
      const mac = await hmac(enc.encode(c), rawBody);
      if (safeEqual(received.toLowerCase(), toHex(mac)) || safeEqual(received, toBase64(mac))) {
        return { ok: true, via: 'x-signature' };
      }
    }
  }

  // 3) Legacy Moonpay-Signature-V2 (ramp-style), kept for forward compatibility.
  const v2 = headers.get('moonpay-signature-v2');
  if (v2) {
    let ts, sig;
    for (const kv of v2.split(',')) {
      const i = kv.indexOf('=');
      if (i < 0) continue;
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      if (k === 't') ts = v;
      else if (k === 's') sig = v.toLowerCase();
    }
    if (ts && sig) {
      // Reject stale deliveries (replay window: 5 minutes).
      const age = Math.abs(Date.now() / 1000 - Number(ts));
      if (Number.isFinite(age) && age <= 300) {
        for (const c of candidates) {
          const expected = toHex(await hmac(enc.encode(c), `${ts}.${rawBody}`));
          if (safeEqual(sig, expected)) return { ok: true, via: 'moonpay-signature-v2' };
        }
      }
    }
  }

  // Header NAMES only — never values, which are the signatures themselves.
  const seen = ['authorization', 'x-signature', 'helio-signature', 'moonpay-signature-v2']
    .filter((h) => headers.get(h));
  return { ok: false, reason: `no scheme matched; auth headers present: ${seen.join(', ') || 'none'}` };
}

// ---- access grant (Supabase REST) ------------------------------------------

const DAY = 86_400_000;

/** How long a single paid period unlocks access, with a grace buffer so a
 *  slightly-late renewal webhook doesn't cause a gap. */
export function accessUntilFor(billing) {
  const days = billing === 'yearly' ? 368 : 32;
  return new Date(Date.now() + days * DAY).toISOString();
}

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// ---- server plans -----------------------------------------------------------

/** Plan slugs whose access belongs to a GUILD rather than to the buyer. */
export function isServerPlan(slug) {
  return typeof slug === 'string' && slug.startsWith('server-');
}

/**
 * Normalize a server id the buyer typed into the key the bot stores guilds
 * under: a bare snowflake on Discord, `tg:<chatId>` on Telegram — that prefix is
 * how the adapters namespace Telegram chats so their ids can't collide with
 * Discord snowflakes (src/adapters/telegram.ts). Returns null when the input
 * isn't a plausible id, so a typo fails at checkout rather than after payment.
 */
export function guildKeyFor(platform, raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (platform === 'telegram') {
    const id = s.replace(/^tg:/i, '');
    return /^-?\d{5,20}$/.test(id) ? `tg:${id}` : null;
  }
  return /^\d{17,20}$/.test(s) ? s : null;
}

/**
 * Attach a paid server plan to the guild it was bought for.
 *
 * Server plans are enforced per-GUILD — guardrails.ts `guildAccess` reads
 * guilds.server_tier + server_access_until — so a Server Pro purchase that only
 * touched the buyer's beta_testers row unlocked nothing for the server. That was
 * the state until checkout started collecting a server id (2026-07-27); every
 * server plan had to be applied by hand in SQL.
 *
 * `created_at` and `name` are deliberately NOT sent. On an existing guild an
 * upsert including created_at would reset the first-seen date the free-trial
 * window is derived from, and a null name would wipe a name the bot recorded.
 */
export async function grantGuildAccess(grant) {
  const SUPABASE_URL = env('SUPABASE_URL');
  const KEY = process.env.SUPABASE_SECRET_KEY || env('SUPABASE_SERVICE_ROLE_KEY');

  const row = {
    id: grant.guildId,
    server_tier: grant.tier,
    server_access_until: grant.accessUntil,
    server_subscription_id: grant.subscriptionId || null,
    server_subscription_provider: grant.provider || null,
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/guilds?on_conflict=id`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
      'User-Agent': 'pip-webhook/1.0', // Supabase secret key is UA-gated
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`supabase guild upsert ${res.status}: ${body}`);
  }
  return grant.guildId;
}

/**
 * Apply a paid grant, whichever provider it came from.
 *
 * Personal plans unlock the buyer. Server plans unlock the GUILD and ALSO write
 * the buyer's row, because that row is what the admin console reads for active
 * subs and MRR — dropping it would make a real sale invisible. It does not hand
 * the buyer a personal plan: `personalPlan()` in guardrails.ts only honours
 * personal-* / elite tiers, so a server-pro tier falls through to trial caps in
 * DMs.
 *
 * A server plan with no guild id still grants the buyer's row (never lose a
 * sale) but cannot unlock the server; it returns unmapped so the caller can log
 * it loudly, since only a human can fix it.
 */
export async function applyGrant(grant) {
  const accessUntil = accessUntilFor(grant.billing);
  const platformId = await grantAccess({
    platform: grant.platform,
    handle: grant.handle,
    name: grant.handle,
    accessUntil,
    tier: grant.plan || null,
    provider: grant.provider,
    subscriptionId: grant.subscriptionId,
    status: 'active',
  });

  if (!isServerPlan(grant.plan)) return { platformId, guildId: null };

  const guildId = guildKeyFor(grant.platform, grant.guildId);
  if (!guildId) return { platformId, guildId: null, guildUnmapped: true };

  await grantGuildAccess({
    guildId,
    tier: grant.plan,
    accessUntil,
    subscriptionId: grant.subscriptionId,
    provider: grant.provider,
  });
  return { platformId, guildId };
}

/**
 * Upsert a beta_testers row keyed by the buyer's handle (`@handle`), mirroring
 * the existing pending-invite pattern. The bot rekeys it to the numeric id the
 * first time that user talks to pip (claimPaidGrant in guardrails.ts).
 *
 * grant = { platform, handle, name, accessUntil, tier, provider, subscriptionId, status }
 */
export async function grantAccess(grant) {
  const SUPABASE_URL = env('SUPABASE_URL');
  const KEY = process.env.SUPABASE_SECRET_KEY || env('SUPABASE_SERVICE_ROLE_KEY');
  const platformId = '@' + String(grant.handle).toLowerCase().replace(/^@+/, '');

  const row = {
    platform: grant.platform,
    platform_id: platformId,
    name: grant.name || grant.handle,
    access_until: grant.accessUntil,
    tier: grant.tier || null,
    subscription_provider: grant.provider || null,
    subscription_id: grant.subscriptionId || null,
    subscription_status: grant.status || 'active',
  };

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/beta_testers?on_conflict=platform,platform_id`,
    {
      method: 'POST',
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
        'User-Agent': 'pip-webhook/1.0', // Supabase secret key is UA-gated
      },
      body: JSON.stringify(row),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`supabase upsert ${res.status}: ${body}`);
  }
  return platformId;
}
