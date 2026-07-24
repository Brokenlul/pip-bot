// MoonPay Commerce webhook — crypto / stablecoin path.
// Verifies the delivery (shared bearer token or Moonpay-Signature-V2 HMAC), then
// unlocks the buyer's pip access. Identity + plan travel in the `meta` object we
// set at checkout (either a colon-packed ref "platform:handle:plan:billing" or
// discrete meta.platform/handle/plan/billing fields); a Discord/Telegram handle
// collected in `customerDetails` is used as a fallback.
//
// Set MOONPAY_WEBHOOK_TOKEN and/or MOONPAY_WEBHOOK_SECRET (plus SUPABASE_URL +
// SUPABASE_SECRET_KEY) in the Vercel pip-site project env.
import { verifyMoonpayWebhook, grantAccess, accessUntilFor } from '../_lib.js';

export const config = { runtime: 'edge' };

// Commerce events that mean "this person has paid / their access is live":
//   CREATED           — a pay-link (one-off) payment completed
//   STARTED / RENEWED — a subscription became / stayed active
// ENDED is ignored: access lapses naturally when renewals stop (accessUntilFor's
// grace buffer covers a slightly-late RENEWED).
const GRANT_EVENTS = new Set(['CREATED', 'STARTED', 'RENEWED']);

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const raw = await req.text();
  const verdict = await verifyMoonpayWebhook(req.headers, raw, {
    token: process.env.MOONPAY_WEBHOOK_TOKEN,
    secret: process.env.MOONPAY_WEBHOOK_SECRET,
  });
  if (!verdict.ok) {
    // Log WHY. A silent 401 here cost a real sale on 2026-07-24: MoonPay retried
    // six times, every delivery was rejected, and nothing said what mismatched.
    console.error(`[moonpay] REJECTED delivery: ${verdict.reason}`);
    return new Response('invalid signature', { status: 401 });
  }

  let evt;
  try { evt = JSON.parse(raw); } catch { return new Response('invalid json', { status: 400 }); }

  // Commerce delivers { event, transactionObject }.
  const type = evt.event || evt.type || '';
  if (!GRANT_EVENTS.has(type)) return Response.json({ ok: true, ignored: type });

  const tx = evt.transactionObject || evt.data || evt;
  const cust = tx.customerDetails || tx.customer || {};
  // Merchant metadata rides in `meta`; some Commerce charge APIs stash it under
  // `additionalJSON` (on the tx or customerDetails, sometimes as a JSON string)
  // instead — merge every shape so the handle/plan is found whichever is used.
  const asObj = (v) => {
    if (v && typeof v === 'object') return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
    return {};
  };
  const meta = {
    ...asObj(tx.additionalJSON),
    ...asObj(cust.additionalJSON),
    ...(tx.metadata || {}),
    ...(tx.meta || {}),
  };

  // Identity + plan travel in `meta` we set at checkout. Accept either a single
  // colon-packed ref ("discord:handle:plan:billing", mirrors the Loop path) or
  // discrete fields; fall back to a handle the buyer entered at checkout.
  let platform, handle, plan, billing;
  const packed = [meta.ref, meta.refId, meta.orderId].find(
    (v) => typeof v === 'string' && v.includes(':'),
  );
  if (packed) {
    [platform, handle, plan, billing] = packed.split(':');
  } else {
    platform = meta.platform;
    handle = meta.handle || cust.discordUsername || cust.telegramUsername || cust.twitterUsername;
    plan = meta.plan;
    billing = meta.billing;
  }

  platform = platform === 'telegram' ? 'telegram' : 'discord';
  billing = billing === 'yearly' ? 'yearly' : 'monthly';
  if (!handle) {
    console.warn(`[moonpay] ${type} with no handle in meta/customerDetails — cannot map to a user`);
    return Response.json({ ok: true, unmapped: true });
  }

  const subId =
    tx.subscriptionId || tx.subscription_id || tx.id || tx.transactionId || null;

  try {
    const platformId = await grantAccess({
      platform,
      handle,
      name: handle,
      accessUntil: accessUntilFor(billing),
      tier: plan || null,
      provider: 'moonpay',
      subscriptionId: subId,
      status: 'active',
    });
    console.log(`[moonpay] ${type}: granted ${platform} ${platformId} (${plan}/${billing})`);
    return Response.json({ ok: true });
  } catch (e) {
    console.error(`[moonpay] grant failed: ${e.message}`);
    return new Response('grant failed', { status: 500 }); // 5xx → MoonPay retries
  }
}
