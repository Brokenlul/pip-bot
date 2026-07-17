// Data layer for the admin console: Supabase REST reads, the Overview pilot
// metrics, and live payment pulls from the Dodo + MoonPay (Helio) APIs.
// Zero dependencies. All reads are server-side; keys never reach the browser.
const { median, p95, dayKey } = require('./_render.js');

// ---- Supabase --------------------------------------------------------------
function sbCreds() {
  return {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
}
async function sb(path) {
  const { url, key } = sbCreds();
  if (!url || !key) throw new Error('supabase not configured');
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const iso = (ms) => new Date(ms).toISOString();
const DAY = 864e5;

async function loadUsage(days = 7) {
  const since = iso(Date.now() - days * DAY);
  return sb(`usage_log?select=created_at,platform,user_id,guild_id,cost_usd,tools_used,had_vision,web_searches,degraded,cache_hit,latency_ms,failed,error_detail&created_at=gte.${since}&order=created_at.desc&limit=50000`);
}
async function loadTesters() {
  return sb('beta_testers?select=platform,platform_id,name,invited_at,access_until,extension_used,extension_tweet_url,extension_claimed_at,tier,subscription_provider,subscription_id,subscription_status&limit=5000');
}
async function loadFeedback(days = 7) {
  const since = iso(Date.now() - days * DAY);
  return sb(`feedback?select=platform,guild_id,rater_id,rating,message_id,created_at&created_at=gte.${since}&limit=10000`);
}
async function loadActivity(limit = 100) {
  return sb(`conversations?select=created_at,guild_id,user_id,question,answer&order=created_at.desc&limit=${limit}`);
}
async function loadUserConversations(userId, limit = 30) {
  return sb(`conversations?select=created_at,guild_id,question,answer&user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=${limit}`);
}
async function loadUserProfile(userId) {
  const rows = await sb(`user_profiles?select=guild_id,profile,updated_at&user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc&limit=5`);
  return rows;
}

// ---- Provider payments (Dodo + MoonPay), cached to bound API calls ---------
const PROVIDER_TTL = 90_000;
let _payCache = { at: 0, data: null };

// slug -> { m: monthly USD charged, y: yearly USD charged } (incl. the +10%).
const TIER = {
  'personal-lite': { m: 13.2, y: 132, label: 'Lite' },
  'personal-pro': { m: 20.9, y: 211.2, label: 'Pro' },
  'server-pro': { m: 31.9, y: 316.8, label: 'Server Pro' },
};
// MoonPay pay link id -> plan, so we can label its transactions.
const MOONPAY_PAYLINKS = [
  { id: '6a58aff5d0dad167e323adb7', slug: 'personal-lite', billing: 'monthly' },
  { id: '6a58aff62e504e36f03c3311', slug: 'personal-lite', billing: 'yearly' },
  { id: '6a58aff7f02c0392e33c23f9', slug: 'personal-pro', billing: 'monthly' },
  { id: '6a58aff82a35ae41a9ec224b', slug: 'personal-pro', billing: 'yearly' },
  { id: '6a58aff926ebf2b46dfda976', slug: 'server-pro', billing: 'monthly' },
  { id: '6a58aff917d45c0458040113', slug: 'server-pro', billing: 'yearly' },
];

// Best-effort field extraction — provider transaction shapes are confirmed to
// exist but were empty at build time (test mode), so read defensively.
function num(...v) { for (const x of v) { const n = Number(x); if (Number.isFinite(n) && n !== 0) return n; } return 0; }
function first(...v) { for (const x of v) if (x != null && x !== '') return x; return null; }

async function fetchDodo() {
  const key = process.env.DODO_API_KEY;
  if (!key) return { ok: false, payments: [], subs: [] };
  // Live by default; set DODO_API_BASE=https://test.dodopayments.com to read test
  // mode. The key must match the mode — a test key 401s against the live host.
  const base = process.env.DODO_API_BASE || 'https://live.dodopayments.com';
  const h = { Authorization: `Bearer ${key}` };
  try {
    const [pRes, sRes] = await Promise.all([
      fetch(`${base}/payments?page_size=100`, { headers: h }),
      fetch(`${base}/subscriptions?page_size=100`, { headers: h }),
    ]);
    const p = pRes.ok ? await pRes.json() : { items: [] };
    const s = sRes.ok ? await sRes.json() : { items: [] };
    const payments = (p.items || []).map((t) => ({
      provider: 'dodo',
      amount: num(t.total_amount, t.amount, t.settlement_amount) / 100, // Dodo amounts are minor units
      currency: first(t.currency, t.settlement_currency, 'USD'),
      created_at: first(t.created_at, t.created),
      status: first(t.status, 'succeeded'),
      who: first(t.customer && (t.customer.email || t.customer.name), t.customer_id),
      raw: t,
    }));
    const subs = (s.items || []).map((t) => ({
      provider: 'dodo',
      status: first(t.status),
      amount: num(t.recurring_pre_tax_amount, t.amount) / 100,
      product: first(t.product_id),
      created_at: first(t.created_at),
    }));
    return { ok: true, payments, subs };
  } catch (e) {
    console.error('[admin] dodo fetch:', e.message);
    return { ok: false, payments: [], subs: [] };
  }
}

async function fetchMoonpay() {
  const pub = process.env.MOONPAY_PUBLIC_KEY;
  const sec = process.env.MOONPAY_SECRET_KEY;
  if (!pub || !sec) return { ok: false, payments: [] };
  const h = { Authorization: `Bearer ${sec}`, Origin: 'https://pipinvest.xyz' };
  const out = [];
  try {
    await Promise.all(MOONPAY_PAYLINKS.map(async (pl) => {
      const r = await fetch(`https://api.hel.io/v1/paylink/${pl.id}/transactions?publicKey=${pub}`, { headers: h });
      if (!r.ok) return;
      const list = await r.json();
      for (const t of Array.isArray(list) ? list : (list.items || [])) {
        const meta = t.meta || t.paymentRequest || {};
        out.push({
          provider: 'moonpay',
          amount: num(t.amountUsd, t.amount, meta.amount) / (t.amount && !t.amountUsd ? 1e6 : 1), // USDC minor units → USD if raw
          currency: first(t.currency, 'USDC'),
          created_at: first(t.createdAt, t.created_at, t.paidAt),
          status: first(t.status, t.paymentStatus, 'success'),
          who: first(t.customerDetails && (t.customerDetails.email || t.customerDetails.discordUsername), t.senderPk),
          slug: pl.slug, billing: pl.billing,
          raw: t,
        });
      }
    }));
    return { ok: true, payments: out };
  } catch (e) {
    console.error('[admin] moonpay fetch:', e.message);
    return { ok: false, payments: out };
  }
}

async function loadPayments() {
  if (_payCache.data && Date.now() - _payCache.at < PROVIDER_TTL) return _payCache.data;
  const [dodo, moon] = await Promise.all([fetchDodo(), fetchMoonpay()]);
  const payments = [...dodo.payments, ...moon.payments]
    .filter((p) => p.created_at)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const data = { payments, dodoSubs: dodo.subs || [], ok: dodo.ok || moon.ok, dodoOk: dodo.ok, moonOk: moon.ok };
  _payCache = { at: Date.now(), data };
  return data;
}

// ---- Subscription / trial classification (mirrors guardrails.ts) -----------
function classify(t, now) {
  const ends = t.access_until ? new Date(t.access_until).getTime() : null;
  const active = ends == null || !Number.isFinite(ends) || now <= ends; // null/infinity => active
  const paid = Boolean(t.subscription_provider) && (t.subscription_status || 'active') === 'active';
  if (paid && active) return 'paid';
  if (!paid && active) return 'trial';
  return 'lapsed';
}
function tierPrice(slug, billing) {
  const t = TIER[slug];
  if (!t) return 0;
  return billing === 'yearly' ? t.y / 12 : t.m;
}
// billing isn't stored; infer from how long the window is (yearly ≈ 368d).
function inferBilling(t) {
  if (!t.access_until || !t.invited_at) return 'monthly';
  const span = new Date(t.access_until).getTime() - new Date(t.invited_at).getTime();
  return span > 90 * DAY ? 'yearly' : 'monthly';
}

// ---- Overview metrics (ported from the original dashboard) ------------------
function overviewMetrics(rows, testers, feedback, caps, founderKeys) {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const testerSet = new Set(testers.map((t) => `${t.platform}:${t.platform_id}`));
  const isFounder = (k) => founderKeys.has(k);
  const roleOf = (r) => { const k = `${r.platform}:${r.user_id}`; return isFounder(k) ? 'founder' : testerSet.has(k) ? 'tester' : 'guest'; };
  for (const r of rows) r._role = roleOf(r);

  const sum = (a, f) => a.reduce((s, r) => s + (Number(f(r)) || 0), 0);
  const today = rows.filter((r) => r.created_at >= dayStart);
  const spendByRole = (role) => sum(today.filter((r) => r._role === role), (r) => r.cost_usd);
  const dm = today.filter((r) => String(r.guild_id).startsWith('dm:'));
  const srv = today.filter((r) => !String(r.guild_id).startsWith('dm:'));

  const tRows = rows.filter((r) => r._role === 'tester');
  const totalTesters = testerSet.size;
  const byTester = new Map();
  for (const r of tRows) {
    const k = `${r.platform}:${r.user_id}`;
    const u = byTester.get(k) || { rows: [], days: new Set(), firstAt: r.created_at };
    u.rows.push(r); u.days.add(dayKey(r.created_at));
    if (r.created_at < u.firstAt) u.firstAt = r.created_at;
    byTester.set(k, u);
  }
  const active = [...byTester.values()];
  const activated = active.filter((u) => {
    const cut = new Date(new Date(u.firstAt).getTime() + 48 * 3600e3).toISOString();
    return u.rows.filter((r) => r.created_at <= cut).length >= 3;
  });
  const activationPct = totalTesters ? activated.length / totalTesters : null;
  const perUserDay = new Map();
  for (const r of tRows) { const k = `${r.platform}:${r.user_id}|${dayKey(r.created_at)}`; perUserDay.set(k, (perUserDay.get(k) || 0) + 1); }
  const engagement = median([...perUserDay.values()]);
  const retentionDays = median(active.map((u) => u.days.size));
  const lastDay = dayKey(now.toISOString());
  const returned = activated.filter((u) => u.days.has(lastDay)).length;
  const day7 = activated.length ? returned / activated.length : null;
  const tFeed = feedback.filter((f) => { const k = `${f.platform}:${f.rater_id}`; return !isFounder(k) && testerSet.has(k); });
  const up = tFeed.filter((f) => f.rating === 'up').length;
  const down = tFeed.filter((f) => f.rating === 'down').length;
  const quality = up + down ? up / (up + down) : null;
  const failedRate = tRows.length ? tRows.filter((r) => r.failed).length / tRows.length : null;
  const nonHit = tRows.filter((r) => !r.cache_hit);
  const costPerMsg = tRows.length ? sum(tRows, (r) => r.cost_usd) / tRows.length : null;
  const p95Latency = p95(nonHit.map((r) => Number(r.latency_ms) || 0).filter((x) => x > 0));

  const weekSpend = sum(rows, (r) => r.cost_usd);
  const cacheHits = rows.filter((r) => r.cache_hit).length;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY).toISOString().slice(0, 10);
    days.push({ day: d, spend: sum(rows.filter((r) => dayKey(r.created_at) === d), (r) => r.cost_usd) });
  }
  const tools = new Map();
  for (const r of rows) for (const t of r.tools_used || []) tools.set(t, (tools.get(t) || 0) + 1);
  const topTools = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  return {
    updated: now, todaySpend: sum(today, (r) => r.cost_usd), todayMsgs: today.length,
    activeTestersToday: new Set(today.filter((r) => r._role === 'tester').map((r) => r.user_id)).size,
    totalTesters, spend: { founder: spendByRole('founder'), tester: spendByRole('tester'), guest: spendByRole('guest') },
    surface: { dm: dm.length, srv: srv.length }, weekSpend, weekMsgs: rows.length,
    cacheRate: rows.length ? cacheHits / rows.length : 0, days, topTools, up, down,
    stack: [
      ['Activation', 'Asked ≥3 in first 48h', activationPct == null ? '—' : `${activated.length}/${totalTesters} · ${Math.round(activationPct * 100)}%`, activationPct != null && activationPct >= 0.8, '≥80%'],
      ['Engagement', 'Median Q / user / active day', engagement == null ? '—' : engagement.toFixed(1), engagement != null && engagement >= 5 && engagement <= 8, '5–8'],
      ['Retention', 'Median active days / 7', retentionDays == null ? '—' : retentionDays.toFixed(1), retentionDays != null && retentionDays >= 4, '≥4'],
      ['Retention', 'Day-7 return', day7 == null ? '—' : `${Math.round(day7 * 100)}%`, day7 != null && day7 >= 0.5, '≥50%'],
      ['Quality', '👍 / 👎 ratio', quality == null ? '— (no votes)' : `${Math.round(quality * 100)}%`, quality != null && quality >= 0.8, '≥80%'],
      ['Quality', 'Failed rate', failedRate == null ? '—' : `${Math.round(failedRate * 100)}%`, failedRate != null && failedRate < 0.1, '<10%'],
      ['Ops', 'Cost / message', costPerMsg == null ? '—' : `$${costPerMsg.toFixed(4)}`, costPerMsg != null && costPerMsg <= 0.06, '≤$0.06'],
      ['Ops', 'p95 latency', p95Latency == null ? '—' : `${(p95Latency / 1000).toFixed(1)}s`, p95Latency != null && p95Latency < 10000, '<10s'],
    ],
  };
}

module.exports = {
  sb, loadUsage, loadTesters, loadFeedback, loadActivity, loadUserConversations, loadUserProfile,
  loadPayments, classify, tierPrice, inferBilling, overviewMetrics, TIER, DAY,
};
