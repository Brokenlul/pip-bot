// First-party analytics ingest. The browser POSTs here (via sendBeacon), we
// write to public.site_events. Runs on the Vercel Edge runtime with no npm
// deps, same as the webhooks.
//
// Deliberately does NOT store: IP address, user-agent, full referrer URL, or
// anything else that identifies a person. Country comes from the edge geo
// header and stops at the 2-letter code. See db/migrations/0012_site_events.sql.
//
// Needs SUPABASE_URL + SUPABASE_SECRET_KEY in the Vercel pip-site env (both are
// already set — api/_lib.js grantAccess uses them).

export const config = { runtime: 'edge' };

// Allowlisted event names. Anything else is dropped, so a stray script or a
// bored visitor can't invent event types and pollute the funnel counts.
const EVENTS = new Set(['pageview', 'click', 'checkout_start', 'checkout_submit']);

// Bound every string we persist. Keeps a hostile payload from bloating rows.
const clamp = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  // Same-origin only. Blocks the endpoint being used as someone else's
  // analytics backend, which would poison our numbers.
  const origin = req.headers.get('origin');
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { return new Response('bad origin', { status: 403 }); }
    if (host !== req.headers.get('host')) return new Response('bad origin', { status: 403 });
  }

  let b;
  try { b = await req.json(); } catch { return new Response('bad request', { status: 400 }); }

  const event = clamp(b.event, 40);
  const visitorId = clamp(b.visitorId, 40);
  const sessionId = clamp(b.sessionId, 40);
  if (!event || !EVENTS.has(event) || !visitorId || !sessionId) {
    // 204 not 400: a rejected beacon must never surface as a console error on
    // the marketing site.
    return new Response(null, { status: 204 });
  }

  // Referrer arrives as a full URL from the client; keep only the host so we
  // never store the path someone came from.
  let referrerHost = null;
  if (typeof b.referrer === 'string' && b.referrer) {
    try {
      const h = new URL(b.referrer).host;
      if (h && h !== req.headers.get('host')) referrerHost = h.slice(0, 120);
    } catch { /* unparseable referrer: drop it */ }
  }

  const row = {
    visitor_id: visitorId,
    session_id: sessionId,
    event,
    path: clamp(b.path, 200),
    target: clamp(b.target, 200),
    referrer_host: referrerHost,
    utm_source: clamp(b.utmSource, 80),
    utm_medium: clamp(b.utmMedium, 80),
    utm_campaign: clamp(b.utmCampaign, 80),
    country: clamp(req.headers.get('x-vercel-ip-country'), 2),
    device: b.device === 'mobile' ? 'mobile' : 'desktop',
    meta: b.meta && typeof b.meta === 'object' ? b.meta : {},
  };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return new Response(null, { status: 204 });

  try {
    const res = await fetch(`${url}/rest/v1/site_events`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) console.warn(`[track] supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } catch (e) {
    console.warn(`[track] insert failed: ${e.message}`);
  }

  // Always 204. Analytics must never be able to break a page load.
  return new Response(null, { status: 204 });
}
