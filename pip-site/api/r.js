/**
 * /r/<code> — a refer-&-earn link.
 *
 * Redirects to the home page with ?ref=<code>, which assets/track.js stores
 * first-touch. Deliberately a redirect rather than a page of its own: the
 * referred person should land on the actual pitch, and first-touch storage
 * means they can wander the site and sign up two days later still credited.
 *
 * Nothing is written to the database here. A referral is only recorded when a
 * real platform account arrives (the bot's claimAttribution, or a "ref <code>"
 * DM) — recording at click time would let anyone manufacture referrals with
 * curl. The click itself is still counted by the normal analytics beacon on the
 * page we redirect to.
 */
export const config = { runtime: 'edge' };

// Same alphabet and length the bot mints (src/memory/referral.ts): no 0/O/1/I/L,
// because these codes get read aloud and typed from phones.
const CODE_RE = /^[a-hj-km-np-z2-9]{6}$/;

export default async function handler(req) {
  const url = new URL(req.url);
  // With the vercel.json rewrite the code arrives as ?code=; fall back to the
  // path so this still works if the rewrite is ever changed to a plain proxy.
  const raw = (url.searchParams.get('code') || url.pathname.split('/').filter(Boolean).pop() || '')
    .toLowerCase();

  const to = new URL('/', url.origin);
  // An unrecognised code just drops the parameter — a broken or mistyped link
  // must still land the visitor on the site rather than showing them an error.
  if (CODE_RE.test(raw)) to.searchParams.set('ref', raw);

  return new Response(null, {
    status: 302,
    headers: {
      Location: to.toString(),
      // Never cache: the code is the whole payload, and a shared CDN entry
      // would send the next visitor to the previous person's referrer.
      'Cache-Control': 'no-store',
    },
  });
}
