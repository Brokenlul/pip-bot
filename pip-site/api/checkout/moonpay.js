// MoonPay Commerce checkout — creates a charge with the buyer's identity baked
// into `meta`, then hands the hosted `pageUrl` back to the site to redirect to.
// MoonPay Commerce hosted pay links can't carry custom metadata via URL params
// (unlike Dodo's ?metadata_* / Loop's ?ref-id), so identity has to be attached
// server-side at charge creation — that's the whole reason this endpoint exists.
// The webhook (api/webhooks/moonpay.js) then reads transactionObject.meta.
//
// Needs MOONPAY_PUBLIC_KEY + MOONPAY_SECRET_KEY in the Vercel pip-site env.

export const config = { runtime: 'edge' };

// slug + billing -> MoonPay Commerce pay link id. FILL THESE IN with the pay
// links you create in the MoonPay Commerce dashboard (one per plan+billing;
// each should be a subscription pay link). Leave '' to keep that option off.
const PAYLINKS = {
  'personal-lite': { monthly: '6a58aff5d0dad167e323adb7', yearly: '6a58aff62e504e36f03c3311' },
  'personal-pro':  { monthly: '6a58aff7f02c0392e33c23f9', yearly: '6a58aff82a35ae41a9ec224b' },
  'server-pro':    { monthly: '6a58aff926ebf2b46dfda976', yearly: '6a58aff917d45c0458040113' },
};

const HELIO_BASE = 'https://api.hel.io/v1';

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); } catch { return Response.json({ error: 'bad request' }, { status: 400 }); }

  const slug = String(body.slug || '');
  const billing = body.billing === 'yearly' ? 'yearly' : 'monthly';
  const platform = body.platform === 'telegram' ? 'telegram' : 'discord';
  const handle = String(body.handle || '').trim().replace(/^@+/, '');
  if (handle.length < 2) return Response.json({ error: 'missing handle' }, { status: 400 });

  const paylinkId = PAYLINKS[slug] && PAYLINKS[slug][billing];
  if (!paylinkId) return Response.json({ error: 'unavailable' }, { status: 503 });

  const pub = process.env.MOONPAY_PUBLIC_KEY;
  const secret = process.env.MOONPAY_SECRET_KEY;
  if (!pub || !secret) return Response.json({ error: 'not configured' }, { status: 503 });

  // Identity + plan ride along as a JSON string in
  // prepareRequestBody.customerDetails.additionalJSON — the field the charge API
  // echoes back in the webhook (our webhook parses it into meta). `ref` mirrors
  // the Loop colon-packed format the webhook already understands; the discrete
  // fields are there for readability / a belt-and-suspenders parse.
  const meta = {
    ref: `${platform}:${handle}:${slug}:${billing}`,
    platform, handle, plan: slug, billing,
  };

  let res;
  try {
    // Confirmed live: POST /charge/api-key with the paylink id as
    // `paymentRequestId`; needs the Origin header + apiKey(public)+Bearer(secret).
    res = await fetch(`${HELIO_BASE}/charge/api-key?apiKey=${encodeURIComponent(pub)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
        Origin: 'https://pipinvest.xyz',
      },
      body: JSON.stringify({
        paymentRequestId: paylinkId,
        prepareRequestBody: { customerDetails: { additionalJSON: JSON.stringify(meta) } },
      }),
    });
  } catch (e) {
    console.error(`[moonpay-checkout] network: ${e.message}`);
    return Response.json({ error: 'upstream unreachable' }, { status: 502 });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[moonpay-checkout] create ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return Response.json({ error: 'checkout failed' }, { status: 502 });
  }

  // Confirmed response field for the hosted checkout page is `pageUrl`.
  const url = data.pageUrl || data.url || (data.id ? `https://app.hel.io/charge/${data.id}` : '');
  if (!url) {
    console.error(`[moonpay-checkout] no pageUrl in response: ${JSON.stringify(data).slice(0, 300)}`);
    return Response.json({ error: 'no checkout url' }, { status: 502 });
  }

  return Response.json({ url });
}
