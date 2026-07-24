// Credentialed read-proxy for MoonPay Commerce (Helio) payment history.
//
// WHY THIS EXISTS (2026-07-24): the admin console used to call Helio directly
// with its OWN copy of MOONPAY_PUBLIC_KEY / MOONPAY_SECRET_KEY. That copy went
// stale — pip-site's keys were rotated at go-live on Jul 17 and the console's,
// set Jul 16, never were — so every console read 401'd ("Api key or token is
// invalid") while checkout kept working fine. The two copies could not be
// reconciled: Vercel marks both vars Sensitive (write-only, no reveal) and Helio
// never shows a secret key twice, so the only way to re-sync them would have
// been to rotate the credentials the live checkout depends on.
//
// The fix is to stop having two copies. MoonPay credentials now live ONLY in
// pip-site (where checkout proves they work); the console authenticates with the
// shared DASHBOARD_TOKEN and reads through here. One secret, one place, nothing
// left to drift.
//
// Returns raw Helio transactions grouped by pay link — this stays a dumb
// credentialed pipe, and the console keeps ownership of how it displays them.
//
// Needs DASHBOARD_TOKEN + MOONPAY_PUBLIC_KEY + MOONPAY_SECRET_KEY in the
// pip-site Vercel env.

import { safeEqual } from '../_lib.js';

export const config = { runtime: 'edge' };

const HELIO_BASE = 'https://api.hel.io/v1';

// Pay link id -> plan, so the console can label each transaction. Mirrors
// PAYLINKS in api/checkout/moonpay.js (that map is keyed for writes, this list
// is ordered for reads).
const PAYLINKS = [
  { id: '6a58aff5d0dad167e323adb7', slug: 'personal-lite', billing: 'monthly' },
  { id: '6a58aff62e504e36f03c3311', slug: 'personal-lite', billing: 'yearly' },
  { id: '6a58aff7f02c0392e33c23f9', slug: 'personal-pro', billing: 'monthly' },
  { id: '6a58aff82a35ae41a9ec224b', slug: 'personal-pro', billing: 'yearly' },
  { id: '6a58aff926ebf2b46dfda976', slug: 'server-pro', billing: 'monthly' },
  { id: '6a58aff917d45c0458040113', slug: 'server-pro', billing: 'yearly' },
];

export default async function handler(req) {
  if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });

  // Shared-secret auth. Deliberately the SAME token the console already uses to
  // log in: adding a second admin credential would recreate the two-copies
  // problem this endpoint exists to remove.
  const expected = process.env.DASHBOARD_TOKEN;
  if (!expected) {
    console.error('[admin-payments] DASHBOARD_TOKEN not set — refusing all reads');
    return Response.json({ error: 'not configured' }, { status: 503 });
  }
  const presented = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!presented || !safeEqual(presented, expected)) {
    return new Response('unauthorized', { status: 401 });
  }

  const pub = process.env.MOONPAY_PUBLIC_KEY;
  const sec = process.env.MOONPAY_SECRET_KEY;
  if (!pub || !sec) return Response.json({ error: 'moonpay not configured' }, { status: 503 });

  // Confirmed against Helio's OpenAPI spec (api.hel.io/v1/docs-json): the param
  // is `apiKey` (public) alongside a Bearer of the secret. Omitting either gives
  // "Please provide apiKey and bearer token"; wrong values give "Api key or
  // token is invalid" — which is exactly what the stale console keys returned.
  const headers = { Authorization: `Bearer ${sec}`, Origin: 'https://pipinvest.xyz' };
  const results = [];
  const failures = [];

  await Promise.all(PAYLINKS.map(async (pl) => {
    const label = `${pl.slug}/${pl.billing}`;
    try {
      const r = await fetch(
        `${HELIO_BASE}/paylink/${pl.id}/transactions?apiKey=${encodeURIComponent(pub)}`,
        { headers },
      );
      if (!r.ok) {
        // Carry the provider's own message through — a bare status is what made
        // the original failure take a week to diagnose.
        const body = await r.text().catch(() => '');
        failures.push(`${label}: HTTP ${r.status} ${body.slice(0, 140)}`.trim());
        return;
      }
      const list = await r.json();
      results.push({
        slug: pl.slug,
        billing: pl.billing,
        transactions: Array.isArray(list) ? list : (list.items || []),
      });
    } catch (e) {
      failures.push(`${label}: ${e.message}`);
    }
  }));

  // All six failing means the credentials are wrong, not that there were no
  // sales. Say so, so the console can show an error instead of a confident $0.
  const ok = failures.length < PAYLINKS.length;
  if (failures.length) {
    console.error(`[admin-payments] ${failures.length}/${PAYLINKS.length} pay links failed: ${failures.join(' | ')}`);
  }

  return Response.json({ ok, results, failures }, { headers: { 'cache-control': 'no-store' } });
}
