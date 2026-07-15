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
function safeEqual(a, b) {
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
