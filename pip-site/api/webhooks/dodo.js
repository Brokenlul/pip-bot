// Dodo Payments webhook — card / merchant-of-record path.
// Verifies the Standard Webhooks signature, then unlocks the buyer's pip access
// by upserting a handle-keyed beta_testers row (claimed to the numeric id when
// they next message pip). Set DODO_WEBHOOK_SECRET in the Vercel project env.
import { verifyStandardWebhook, applyGrant } from '../_lib.js';

export const config = { runtime: 'edge' };

// Events that mean "this person has paid / their subscription is live".
const GRANT_EVENTS = new Set([
  'payment.succeeded',
  'subscription.active',
  'subscription.renewed',
]);

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const raw = await req.text();
  const ok = await verifyStandardWebhook(req.headers, raw, process.env.DODO_WEBHOOK_SECRET);
  if (!ok) return new Response('invalid signature', { status: 401 });

  let evt;
  try { evt = JSON.parse(raw); } catch { return new Response('invalid json', { status: 400 }); }

  const type = evt.type || evt.event_type || '';
  if (!GRANT_EVENTS.has(type)) {
    // Ack non-grant events (cancellations lapse naturally as renewals stop).
    return Response.json({ ok: true, ignored: type });
  }

  const data = evt.data || evt;
  const meta = data.metadata || data.data?.metadata || evt.metadata || {};
  const handle = meta.handle;
  const platform = meta.platform === 'telegram' ? 'telegram' : 'discord';
  if (!handle) {
    console.warn(`[dodo] ${type} with no handle metadata — cannot map to a user`);
    return Response.json({ ok: true, unmapped: true });
  }

  const billing = meta.billing === 'yearly' ? 'yearly' : 'monthly';
  const subId = data.subscription_id || data.data?.subscription_id || data.payment_id || null;

  try {
    const { platformId, guildId, guildUnmapped } = await applyGrant({
      platform,
      handle,
      plan: meta.plan || null,
      billing,
      provider: 'dodo',
      subscriptionId: subId,
      guildId: meta.guild_id || meta.guildId,
    });
    if (guildUnmapped) {
      // Paid for a server plan, but nothing says which server. Only a human can
      // resolve it, so retrying is pointless — make it loud instead of silent.
      console.error(`[dodo] ${type}: server plan ${meta.plan} for ${platform} ${platformId} has NO guild id — server not unlocked, set guilds.server_tier by hand`);
    }
    console.log(`[dodo] ${type}: granted ${platform} ${platformId} (${meta.plan}/${billing})${guildId ? ` guild ${guildId}` : ''}`);
    return Response.json({ ok: true });
  } catch (e) {
    console.error(`[dodo] grant failed: ${e.message}`);
    return new Response('grant failed', { status: 500 }); // 5xx → Dodo retries
  }
}
