// Discord bot-install callback. Closes the funnel's biggest blind spot: until
// now a visitor clicked "Add Pip to your server" and vanished — we could not
// tell an abandoned install screen from a completed one.
//
// assets/track.js stamps the outbound authorize URL with state=<token> and
// points redirect_uri here. Discord sends the visitor back with:
//   ?code=...&state=<token>&guild_id=<snowflake>&permissions=...
//
// We deliberately DO NOT exchange the code. guild_id arrives in the query
// string for bot authorizations, which is the only field we want, and skipping
// the exchange means this endpoint needs no client secret at all.
//
// Requires https://pipinvest.xyz/api/discord-installed to be registered as a
// redirect URI on the Discord application, or Discord rejects the authorize
// link before the user ever sees it.

export const config = { runtime: 'edge' };

const WELCOME = 'https://pipinvest.xyz/welcome?installed=1';
const PLAIN = 'https://pipinvest.xyz/welcome';

// A token we minted is 32 hex chars. Anything else is someone poking at the
// endpoint; we still redirect them somewhere sensible, we just record nothing.
const TOKEN_RE = /^[a-f0-9]{32}$/;

export default async function handler(req) {
  const url = new URL(req.url);
  const state = url.searchParams.get('state');
  const guildId = url.searchParams.get('guild_id');

  // The visitor's browser is mid-redirect: whatever happens below, they must
  // land on a real page. Never show them an error for a tracking failure.
  const dest = guildId ? WELCOME : PLAIN;

  if (!state || !TOKEN_RE.test(state) || !guildId) return redirect(dest);

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) return redirect(dest);

  try {
    // Find the click that minted this token so we can carry the visitor across.
    // meta->>token is the join; the token is single-use and random.
    const q =
      `${SUPABASE_URL}/rest/v1/site_events` +
      `?select=visitor_id,created_at&event=eq.click&meta->>token=eq.${encodeURIComponent(state)}&limit=1`;
    const found = await fetch(q, { headers: sbHeaders(KEY) });
    const rows = found.ok ? await found.json() : [];
    const click = rows[0] || null;

    await fetch(`${SUPABASE_URL}/rest/v1/attribution_claims?on_conflict=token`, {
      method: 'POST',
      headers: { ...sbHeaders(KEY), 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        token: state,
        visitor_id: click ? click.visitor_id : null,
        intent: 'discord_bot',
        minted_at: click ? click.created_at : null,
        platform: 'discord',
        guild_id: String(guildId).slice(0, 40),
      }),
    });
  } catch (e) {
    // A tracking failure must never cost us the install.
    console.warn(`[discord-installed] claim failed: ${e.message}`);
  }

  return redirect(dest);
}

function sbHeaders(key) {
  return { apikey: key, authorization: `Bearer ${key}` };
}

function redirect(location) {
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });
}
