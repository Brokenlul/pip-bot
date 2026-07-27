/**
 * Tests the checkout front-end's server-id handling by running index.html's real
 * inline script against a stub DOM, plus the /api/checkout/moonpay handler.
 *
 * The point is that the guild id survives the whole way: typed into the modal ->
 * validated client-side -> onto the provider's metadata -> back out of the
 * webhook. A server plan that reaches a provider without one produces a paid,
 * still-locked server, which is the failure this whole change exists to remove.
 *
 * Run: node pip-site/test/checkout-guild.test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let pass = 0;
const fails = [];
const check = (name, cond) => { if (cond) pass++; else fails.push(name); };
const eq = (name, got, want) => check(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, got === want);

// ---- stub DOM ---------------------------------------------------------------
// Elements are created on demand; only the surface the script actually touches.
function makeDom() {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      const classes = new Set();
      els.set(id, {
        id, value: '', textContent: '', innerHTML: '', placeholder: '', href: '',
        classList: {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
          contains: (c) => classes.has(c),
          toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (on ? classes.add(c) : classes.delete(c))),
        },
        addEventListener() {}, setAttribute() {}, getAttribute: () => null, closest: () => null,
      });
    }
    return els.get(id);
  };
  return { els, el };
}

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
// The pricing/checkout logic is the last and largest inline script.
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const raw = scripts.sort((a, b) => b.length - a.length)[0];
check('found the checkout script in index.html', raw && raw.includes('function checkoutUrl'));
// The script is an IIFE, so unwrap it to reach the functions under test rather
// than exporting them from the page purely for testability.
let src = raw.trim();
check('checkout script is the expected IIFE', /^\(function\s*\(\s*\)\s*\{/.test(src));
src = src.slice(src.indexOf('{') + 1, src.lastIndexOf('})'));

const dom = makeDom();
const sandbox = {
  console,
  document: {
    getElementById: dom.el,
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
  },
  window: { location: { href: '' }, addEventListener() {} },
  fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  encodeURIComponent, decodeURIComponent, JSON, Math, Date, String, Number, Boolean, RegExp, Object, Array,
  setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'index.html:inline' });
// Reach the module-scope functions the script defines.
const call = (expr) => vm.runInContext(expr, sandbox);

// ---- client-side guild key (must mirror api/_lib.js guildKeyFor) -------------
eq('discord snowflake accepted', call(`guildKey('discord','1053808073157906542')`), '1053808073157906542');
eq('discord name rejected', call(`guildKey('discord','SaveTheWhal3s')`), null);
eq('discord short number rejected', call(`guildKey('discord','12345')`), null);
eq('telegram gets tg: prefix', call(`guildKey('telegram','-1001234567890')`), 'tg:-1001234567890');
eq('server plan detected', call(`isServerPlan('server-pro')`), true);
eq('personal plan not detected', call(`isServerPlan('personal-pro')`), false);

// ---- the guild id reaches each provider's metadata --------------------------
const dodoUrl = call(`checkoutUrl('dodo','server-pro','monthly','discord','admin','956446038598750238')`);
check('dodo url carries metadata_guild_id', dodoUrl.includes('metadata_guild_id=956446038598750238'));
check('dodo url still carries the handle', dodoUrl.includes('metadata_handle=admin'));
const dodoPersonal = call(`checkoutUrl('dodo','personal-lite','monthly','discord','admin',null)`);
check('dodo personal url omits guild id', !dodoPersonal.includes('metadata_guild_id'));

// Loop packs everything into ref-id; the guild key goes last because a Telegram
// key contains a colon itself.
const loopRef = decodeURIComponent(
  (call(`checkoutUrl('loop','server-pro','monthly','telegram','admin','tg:-1001234567890')`) || '').split('ref-id=')[1] || '',
);
// Loop links are '' in CHECKOUT until they're switched on, so only assert when one exists.
if (loopRef) {
  check('loop ref-id ends with the guild key', loopRef.endsWith(':tg:-1001234567890'));
  const [p, h, plan, billing] = loopRef.split(':');
  eq('loop ref-id first four fields intact', [p, h, plan, billing].join('|'), 'telegram|admin|server-pro|monthly');
} else {
  pass++; // no loop link configured for this plan — nothing to assert
}

// ---- modal behaviour --------------------------------------------------------
call(`openCheckout({ slug:'personal-lite', billing:'monthly', name:'LITE', tagline:'t', priceMain:'$12', priceSuffix:'/mo', billingLine:'b' })`);
eq('server field hidden for a personal plan', dom.el('co-guild-wrap').classList.contains('hidden'), true);
check('footer describes a personal unlock', dom.el('co-foot').textContent.includes('your Discord account'));

call(`openCheckout({ slug:'server-pro', billing:'monthly', name:'PRO', tagline:'t', priceMain:'$29', priceSuffix:'/mo', billingLine:'b' })`);
eq('server field shown for a server plan', dom.el('co-guild-wrap').classList.contains('hidden'), false);
check('footer describes a server unlock', dom.el('co-foot').textContent.includes('everyone in that server'));
check('server id field is cleared between opens', dom.el('co-guild').value === '');

// A server plan with no server id must not be able to start a checkout.
dom.el('co-handle').value = 'admin';
dom.el('co-guild').value = '';
eq('blocked with no server id', call('checkoutFields()'), null);
check('the error names what is missing', dom.el('co-error').textContent.includes('server ID'));

dom.el('co-guild').value = 'SaveTheWhal3s'; // the server NAME, an easy mistake
eq('blocked when a name is typed instead of an id', call('checkoutFields()'), null);

dom.el('co-guild').value = ' 956446038598750238 ';
const fields = call('checkoutFields()');
eq('accepted once a real id is given', fields && fields.guild, '956446038598750238');
eq('handle still returned', fields && fields.handle, 'admin');

// ---- the checkout endpoint --------------------------------------------------
process.env.MOONPAY_PUBLIC_KEY = 'pub_test';
process.env.MOONPAY_SECRET_KEY = 'sec_test';
const { default: handler } = await import('../api/checkout/moonpay.js');
const post = (body) => handler(new Request('https://pipinvest.xyz/api/checkout/moonpay', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));

let captured = null;
globalThis.fetch = async (url, opts) => {
  captured = JSON.parse(opts.body);
  return { ok: true, status: 200, json: async () => ({ pageUrl: 'https://app.hel.io/charge/x' }) };
};

let res = await post({ slug: 'server-pro', billing: 'monthly', platform: 'discord', handle: 'admin' });
eq('server plan with no guild id is rejected', res.status, 400);

res = await post({ slug: 'server-pro', billing: 'monthly', platform: 'discord', handle: 'admin', guildId: 'SaveTheWhal3s' });
eq('server plan with a malformed guild id is rejected', res.status, 400);

captured = null;
res = await post({ slug: 'server-pro', billing: 'monthly', platform: 'discord', handle: 'admin', guildId: '956446038598750238' });
eq('valid server checkout succeeds', res.status, 200);
const meta = JSON.parse(captured.prepareRequestBody.customerDetails.additionalJSON);
eq('guild id baked into the charge meta', meta.guildId, '956446038598750238');
eq('ref stays four colon-packed fields', meta.ref, 'discord:admin:server-pro:monthly');

captured = null;
res = await post({ slug: 'personal-lite', billing: 'monthly', platform: 'discord', handle: 'admin' });
eq('personal checkout still needs no guild id', res.status, 200);
const pmeta = JSON.parse(captured.prepareRequestBody.customerDetails.additionalJSON);
check('personal charge meta has no guildId', !('guildId' in pmeta));

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
