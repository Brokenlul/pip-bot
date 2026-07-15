// Loop Crypto webhook — USDC path.
// Verifies the loop-signature HMAC, then unlocks the buyer's pip access. The
// handle/plan/billing travel in the ref-id we set on the checkout link
// (`platform:handle:slug:billing`). Set LOOP_WEBHOOK_SECRET in the Vercel env.
import { verifyLoopWebhook, grantAccess, accessUntilFor } from '../_lib.js';

export const config = { runtime: 'edge' };

const GRANT_EVENTS = new Set(['payment.processed', 'payin.created']);

/** Find the `ref-id` we attached at checkout, wherever Loop echoes it. */
function findRef(evt) {
  const d = evt.data || evt;
  const candidates = [
    evt.refId, evt.ref_id, evt['ref-id'],
    d.refId, d.ref_id, d['ref-id'],
    d.metadata?.refId, d.metadata?.ref_id,
    d.externalId, d.reference,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.includes(':')) return c;
  }
  return null;
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const raw = await req.text();
  const ok = await verifyLoopWebhook(req.headers, raw, process.env.LOOP_WEBHOOK_SECRET);
  if (!ok) return new Response('invalid signature', { status: 401 });

  let evt;
  try { evt = JSON.parse(raw); } catch { return new Response('invalid json', { status: 400 }); }

  const type = evt.event || evt.type || evt.eventType || '';
  if (!GRANT_EVENTS.has(type)) return Response.json({ ok: true, ignored: type });

  const ref = findRef(evt);
  if (!ref) {
    console.warn(`[loop] ${type} with no ref-id — cannot map to a user`);
    return Response.json({ ok: true, unmapped: true });
  }

  const [platformRaw, handle, plan, billingRaw] = ref.split(':');
  const platform = platformRaw === 'telegram' ? 'telegram' : 'discord';
  const billing = billingRaw === 'yearly' ? 'yearly' : 'monthly';
  if (!handle) return Response.json({ ok: true, unmapped: true });

  const d = evt.data || evt;
  const subId = d.subscriptionId || d.subscription_id || d.payinId || d.id || null;

  try {
    const platformId = await grantAccess({
      platform,
      handle,
      name: handle,
      accessUntil: accessUntilFor(billing),
      tier: plan || null,
      provider: 'loop',
      subscriptionId: subId,
      status: 'active',
    });
    console.log(`[loop] ${type}: granted ${platform} ${platformId} (${plan}/${billing})`);
    return Response.json({ ok: true });
  } catch (e) {
    console.error(`[loop] grant failed: ${e.message}`);
    return new Response('grant failed', { status: 500 });
  }
}
