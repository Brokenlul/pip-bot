/**
 * Regression tests for verifyMoonpayWebhook.
 *
 * Written after the 2026-07-24 incident in which a real $12.94 sale granted no
 * access: the verifier only understood MoonPay's *ramp* scheme
 * (`Moonpay-Signature-V2: t=..,s=..` over `<ts>.<body>`), while MoonPay Commerce
 * / Helio actually sends `Authorization: Bearer <sharedToken>` plus
 * `X-Signature` = hex HMAC-SHA256 of the RAW body. Six deliveries 401'd.
 *
 * The 2026-07-17 "webhook verified" probe missed this because it signed its own
 * test deliveries using our verifier's scheme — it checked the code against
 * itself. These cases instead assert the shapes the PROVIDER sends, per
 * docs.hel.io/docs/webhooks, and assert fail-closed on everything else.
 *
 * Run: node pip-site/test/verify-moonpay.test.mjs
 */
import { verifyMoonpayWebhook } from '../api/_lib.js';

const enc = new TextEncoder();
const TOKEN = 'shared_tok_abc123';
const BODY = JSON.stringify({ event: 'CREATED', transaction: { id: 't_1', amount: '12936000' } });

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmacB64(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return Buffer.from(new Uint8Array(sig)).toString('base64');
}
const H = (o) => new Headers(o);

let pass = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name} — ${e.message}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

console.log('verifyMoonpayWebhook');

// --- the schemes Helio actually sends -------------------------------------
await check('accepts Authorization: Bearer <sharedToken>', async () => {
  const r = await verifyMoonpayWebhook(H({ authorization: `Bearer ${TOKEN}` }), BODY, { token: TOKEN });
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  assert(r.via === 'bearer', `expected via=bearer, got ${r.via}`);
});

await check('accepts X-Signature hex HMAC over the raw body', async () => {
  const r = await verifyMoonpayWebhook(H({ 'x-signature': await hmacHex(TOKEN, BODY) }), BODY, { token: TOKEN });
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  assert(r.via === 'x-signature', `expected via=x-signature, got ${r.via}`);
});

await check('accepts X-Signature with a sha256= prefix', async () => {
  const r = await verifyMoonpayWebhook(H({ 'x-signature': `sha256=${await hmacHex(TOKEN, BODY)}` }), BODY, { token: TOKEN });
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
});

await check('accepts X-Signature base64 encoding', async () => {
  const r = await verifyMoonpayWebhook(H({ 'x-signature': await hmacB64(TOKEN, BODY) }), BODY, { token: TOKEN });
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
});

// --- the env-var mixup that made the bearer branch dead in prod ------------
await check('sharedToken in MOONPAY_WEBHOOK_SECRET still verifies (bearer)', async () => {
  const r = await verifyMoonpayWebhook(H({ authorization: `Bearer ${TOKEN}` }), BODY, { secret: TOKEN });
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
});

await check('sharedToken in MOONPAY_WEBHOOK_SECRET still verifies (x-signature)', async () => {
  const r = await verifyMoonpayWebhook(H({ 'x-signature': await hmacHex(TOKEN, BODY) }), BODY, { secret: TOKEN });
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
});

// --- fail closed ----------------------------------------------------------
await check('rejects when no env is configured', async () => {
  const r = await verifyMoonpayWebhook(H({ authorization: `Bearer ${TOKEN}` }), BODY, {});
  assert(!r.ok, 'must fail closed with no env');
  assert(/no MOONPAY_WEBHOOK/.test(r.reason), `reason should name the missing env, got: ${r.reason}`);
});

await check('rejects a wrong bearer token', async () => {
  const r = await verifyMoonpayWebhook(H({ authorization: 'Bearer wrong_token' }), BODY, { token: TOKEN });
  assert(!r.ok, 'must reject a wrong token');
});

await check('rejects a signature made with the wrong key', async () => {
  const r = await verifyMoonpayWebhook(H({ 'x-signature': await hmacHex('wrong_key', BODY) }), BODY, { token: TOKEN });
  assert(!r.ok, 'must reject a wrong-key signature');
});

await check('rejects a tampered body', async () => {
  const sig = await hmacHex(TOKEN, BODY);
  const r = await verifyMoonpayWebhook(H({ 'x-signature': sig }), BODY.replace('12936000', '99999999'), { token: TOKEN });
  assert(!r.ok, 'must reject when the body no longer matches the signature');
});

await check('rejects with no auth headers at all', async () => {
  const r = await verifyMoonpayWebhook(H({}), BODY, { token: TOKEN });
  assert(!r.ok, 'must reject with no headers');
  assert(/none/.test(r.reason), `reason should say no auth headers present, got: ${r.reason}`);
});

await check('rejection reason names headers but never leaks values', async () => {
  const sig = await hmacHex('wrong_key', BODY);
  const r = await verifyMoonpayWebhook(H({ 'x-signature': sig, authorization: 'Bearer nope' }), BODY, { token: TOKEN });
  assert(!r.ok, 'expected rejection');
  assert(r.reason.includes('x-signature'), 'reason should name the headers seen');
  assert(!r.reason.includes(sig) && !r.reason.includes('nope'), 'reason must NOT contain header values');
  assert(!r.reason.includes(TOKEN), 'reason must NOT contain the secret');
});

// --- legacy ramp scheme, kept for forward compatibility -------------------
await check('still accepts legacy Moonpay-Signature-V2 within the replay window', async () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await hmacHex(TOKEN, `${ts}.${BODY}`);
  const r = await verifyMoonpayWebhook(H({ 'moonpay-signature-v2': `t=${ts},s=${sig}` }), BODY, { secret: TOKEN });
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  assert(r.via === 'moonpay-signature-v2', `expected via=moonpay-signature-v2, got ${r.via}`);
});

await check('rejects a stale legacy V2 delivery (replay guard)', async () => {
  const ts = Math.floor(Date.now() / 1000) - 3600;
  const sig = await hmacHex(TOKEN, `${ts}.${BODY}`);
  const r = await verifyMoonpayWebhook(H({ 'moonpay-signature-v2': `t=${ts},s=${sig}` }), BODY, { secret: TOKEN });
  assert(!r.ok, 'must reject a 1-hour-old delivery');
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
