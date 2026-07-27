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
async function loadSafetyEvents(days = 7) {
  const since = iso(Date.now() - days * DAY);
  return sb(`safety_event?select=created_at,platform,guild_id,user_id,kind,detail&created_at=gte.${since}&order=created_at.desc&limit=5000`);
}
async function loadSiteEvents(days = 7) {
  const since = iso(Date.now() - days * DAY);
  return sb(`site_events?select=created_at,visitor_id,session_id,event,path,target,referrer_host,utm_source,utm_campaign,country,device&created_at=gte.${since}&order=created_at.desc&limit=50000`);
}
// ---- CRM writes ------------------------------------------------------------
// The console is read-only everywhere else on purpose. These three are the
// exception: they are the whole point of the People view, and each is scoped to
// a single (platform, platform_id) so a bug cannot touch more than one person.
async function sbWrite(path, method, body, extraPrefer) {
  const { url, key } = sbCreds();
  if (!url || !key) throw new Error('supabase not configured');
  const r = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      prefer: extraPrefer || 'return=minimal',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json().catch(() => null);
}

async function loadAttribution(limit = 5000) {
  return sb(`attribution_claims?select=token,visitor_id,intent,minted_at,claimed_at,platform,platform_id,guild_id,meta&order=claimed_at.desc&limit=${limit}`);
}
async function loadLabels() {
  return sb('person_labels?select=platform,platform_id,labels,note,updated_at&limit=5000');
}

/** Replace a person's label set. Upsert so an untagged lead can be tagged. */
async function saveLabels(platform, platformId, labels, note) {
  return sbWrite(
    'person_labels?on_conflict=platform,platform_id',
    'POST',
    {
      platform,
      platform_id: platformId,
      labels,
      note: note || null,
      updated_at: new Date().toISOString(),
    },
    'resolution=merge-duplicates,return=minimal',
  );
}

/**
 * Grant or revoke access. `days` extends from NOW, not from the old expiry —
 * extending an already-lapsed user by 7 days from a past date would grant them
 * nothing. days=0 revokes by expiring them immediately.
 *
 * extension_used is deliberately NOT touched: that flag belongs to the
 * tweet-for-a-week grant, and a founder comp must not burn the user's one tweet.
 */
async function setAccess(platform, platformId, days) {
  const until = days > 0 ? new Date(Date.now() + days * DAY).toISOString() : new Date().toISOString();
  const q = `beta_testers?platform=eq.${encodeURIComponent(platform)}&platform_id=eq.${encodeURIComponent(platformId)}`;
  const updated = await sbWrite(q, 'PATCH', { access_until: until }, 'return=representation');
  // No row means this is a lead who never messaged. Create one so the grant
  // actually lands — otherwise the button silently does nothing.
  if (!updated || updated.length === 0) {
    await sbWrite('beta_testers?on_conflict=platform,platform_id', 'POST', {
      platform, platform_id: platformId, name: 'granted', access_until: until,
    }, 'resolution=merge-duplicates,return=minimal');
  }
  return until;
}

async function loadGuilds() {
  return sb('guilds?select=id,name,created_at,installed_at,removed_at,greeted_at,server_tier,server_access_until,server_subscription_provider&limit=2000');
}

/** Server plans are per-guild, so a trial has to be derived, not read. */
const TRIAL_DAYS = 7;

/**
 * A guild's access window — MIRRORS guildAccess() in src/beta/guardrails.ts.
 * Keep the two in step: if this disagrees with the bot, the console will show
 * a server as live while Pip is refusing it (or the reverse), which is worse
 * than showing nothing.
 *
 * Paid wins when server_access_until is in the future AND the tier is a real
 * server tier. Otherwise the guild is on its free trial, derived from
 * created_at + 7d — there is no trial row to read. An unknown created_at fails
 * OPEN in the bot, so it's reported as unknown here rather than as expired.
 */
function guildAccess(g, now = Date.now()) {
  const paidUntil = g.server_access_until ? new Date(g.server_access_until).getTime() : 0;
  const tier = g.server_tier || '';
  if (Number.isFinite(paidUntil) && paidUntil > now && (tier === 'server-pro' || tier === 'elite')) {
    return {
      kind: 'paid',
      plan: (TIER[tier] || {}).label || tier,
      until: g.server_access_until,
      provider: g.server_subscription_provider || null,
    };
  }
  const created = g.created_at ? new Date(g.created_at).getTime() : null;
  if (created == null || !Number.isFinite(created)) {
    return { kind: 'unknown', plan: 'trial (start unknown)', until: null, provider: null };
  }
  const until = new Date(created + TRIAL_DAYS * DAY).toISOString();
  return {
    kind: until > new Date(now).toISOString() ? 'trial' : 'lapsed',
    plan: 'server trial',
    until,
    provider: null,
  };
}
async function loadGuildLabels() {
  return sb('guild_labels?select=guild_id,labels,note,updated_at&limit=5000');
}
/** Replace a guild's label set. Upsert so an untagged server can be tagged. */
async function saveGuildLabel(guildId, labels, note) {
  return sbWrite(
    'guild_labels?on_conflict=guild_id',
    'POST',
    {
      guild_id: guildId,
      labels,
      note: note || null,
      updated_at: new Date().toISOString(),
    },
    'resolution=merge-duplicates,return=minimal',
  );
}
async function loadHeartbeat() {
  return sb('bot_heartbeat?select=platform,last_seen');
}
async function loadSentimentEvents(days = 7) {
  const since = iso(Date.now() - days * DAY);
  return sb(`sentiment_event?select=created_at,platform,guild_id,user_id,excerpt,matched_terms&created_at=gte.${since}&order=created_at.desc&limit=2000`);
}
/**
 * conversations rows carrying the given message ids — traces a 👎 back to the
 * actual flagged question/answer. No FK exists between feedback.message_id and
 * conversations.message_id (feedback predates it and spans platforms), so this
 * is a manual client-side join like the rest of the dashboard's CRM views.
 * Chunked to stay well under PostgREST's URL length limits.
 */
async function loadConversationsByMessageIds(messageIds) {
  const ids = [...new Set(messageIds)].filter(Boolean).map(String);
  if (!ids.length) return [];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  const results = await Promise.all(
    chunks.map((c) =>
      sb(`conversations?select=guild_id,user_id,question,answer,message_id,created_at&message_id=in.(${c.map(encodeURIComponent).join(',')})`),
    ),
  );
  return results.flat();
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
// The MoonPay pay link -> plan table lives with the credentials, in
// pip-site/api/admin/payments.js; each transaction arrives already labelled.

// Best-effort field extraction — provider transaction shapes are confirmed to
// exist but were empty at build time (test mode), so read defensively.
function num(...v) { for (const x of v) { const n = Number(x); if (Number.isFinite(n) && n !== 0) return n; } return 0; }
function first(...v) { for (const x of v) if (x != null && x !== '') return x; return null; }

async function fetchDodo() {
  const key = process.env.DODO_API_KEY;
  if (!key) return { ok: false, payments: [], subs: [], failures: ['DODO_API_KEY not set'] };
  // Live by default; set DODO_API_BASE=https://test.dodopayments.com to read test
  // mode. The key must match the mode — a test key 401s against the live host.
  const base = process.env.DODO_API_BASE || 'https://live.dodopayments.com';
  const h = { Authorization: `Bearer ${key}` };
  const failures = [];
  try {
    const [pRes, sRes] = await Promise.all([
      fetch(`${base}/payments?page_size=100`, { headers: h }),
      fetch(`${base}/subscriptions?page_size=100`, { headers: h }),
    ]);
    // A non-ok response used to collapse into an empty list while this function
    // still returned ok:true, so a 401 rendered a confident $0 revenue table
    // with no banner. That is exactly what hid the MoonPay outage for a week
    // (2026-07-24) — a payment read that fails must say so, loudly.
    const read = async (res, what) => {
      if (res.ok) return res.json();
      failures.push(`${what} HTTP ${res.status}`);
      return { items: [] };
    };
    const p = await read(pRes, 'payments');
    const s = await read(sRes, 'subscriptions');
    const payments = (p.items || []).map((t) => ({
      provider: 'dodo',
      id: first(t.payment_id, t.id, t.reference_id), // read defensively; used by PAYMENTS_EXCLUDE_IDS
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
    if (failures.length) console.error(`[admin] dodo: ${failures.join(' | ')}`);
    return { ok: failures.length === 0, payments, subs, failures };
  } catch (e) {
    console.error('[admin] dodo fetch:', e.message);
    return { ok: false, payments: [], subs: [], failures: [e.message] };
  }
}

/**
 * MoonPay payments, read through pip-site rather than from Helio directly.
 *
 * This console used to hold its own MOONPAY_PUBLIC_KEY / MOONPAY_SECRET_KEY. On
 * 2026-07-24 that copy turned out to be stale (pip-site's keys were rotated at
 * go-live, this project's were not), so every read 401'd while checkout kept
 * working — and neither copy could be read back to re-sync them, because Vercel
 * marks them Sensitive and Helio never re-shows a secret. The credentials now
 * live in exactly one project, and this asks that project.
 */
async function fetchMoonpay() {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return { ok: false, payments: [], failures: ['DASHBOARD_TOKEN not set'] };
  const base = (process.env.PIP_SITE_BASE || 'https://pipinvest.xyz').replace(/\/+$/, '');
  const out = [];
  try {
    const r = await fetch(`${base}/api/admin/payments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      const msg = `payments proxy HTTP ${r.status}`;
      console.error(`[admin] moonpay ${msg}`);
      return { ok: false, payments: [], failures: [msg] };
    }
    const data = await r.json();
    for (const grp of data.results || []) {
      for (const t of grp.transactions || []) {
        const meta = t.meta || t.paymentRequest || {};

        // Helio reports amounts in token MINOR units (USDC/USDT = 6dp), and the
        // real fields are nested under `meta`, not on the transaction. The old
        // mapping guessed from top-level fields that don't exist, so the first
        // real sale rendered as $12,936,000.00. Derive the divisor from the
        // quote (toAmountMinimal / fromAmountDecimal) so a token with different
        // decimals can't inflate revenue by a factor of a million; fall back to
        // 1e6, which is right for every stablecoin these pay links accept.
        const q = meta.tokenQuote || {};
        const minorPerUnit = (() => {
          const m = Number(q.toAmountMinimal);
          const d = Number(q.fromAmountDecimal);
          return Number.isFinite(m) && Number.isFinite(d) && d > 0 ? m / d : 1e6;
        })();
        const decimal = Number(t.amountUsd); // already-decimal field, if ever present
        const amount = Number.isFinite(decimal) && decimal > 0
          ? decimal
          : num(meta.totalAmountAsUSD, meta.amount, meta.totalAmount, t.amount) / minorPerUnit;

        // Who paid. The checkout bakes identity into customerDetails
        // .additionalJSON ("discord:<handle>:<plan>:<billing>"); prefer that over
        // the email, since the handle is what access is actually granted against.
        const cust = meta.customerDetails || t.customerDetails || {};
        let extra = {};
        try { extra = JSON.parse(cust.additionalJSON || '{}'); } catch { /* not JSON */ }
        const who = extra.handle
          ? `${extra.platform || 'discord'}:${extra.handle}`
          : first(cust.email, cust.discordUser, cust.telegramUser, meta.senderPK);

        // A refunded transaction is still in the ledger and must not count as
        // revenue — the Jul 17 test sale was refunded and was being summed.
        const refunded = Array.isArray(t.refunds) && t.refunds.length > 0;

        out.push({
          provider: 'moonpay',
          id: first(t.id, t._id, t.transactionId), // read defensively; used by PAYMENTS_EXCLUDE_IDS
          amount,
          currency: first(q.to && q.to.symbol, t.currency, 'USDC'),
          created_at: first(t.createdAt, t.created_at, t.paidAt),
          status: refunded ? 'refunded' : String(first(meta.transactionStatus, t.status, t.paymentStatus, 'success')).toLowerCase(),
          refunded,
          who,
          slug: grp.slug, billing: grp.billing,
          raw: t,
        });
      }
    }
    if (data.failures && data.failures.length) {
      console.error(`[admin] moonpay upstream failures: ${data.failures.join(' | ')}`);
    }
    return { ok: data.ok !== false, payments: out, failures: data.failures || [] };
  } catch (e) {
    console.error('[admin] moonpay proxy:', e.message);
    return { ok: false, payments: out, failures: [e.message] };
  }
}

/**
 * Payment ids to hide from the console, comma-separated in PAYMENTS_EXCLUDE_IDS.
 *
 * Test transactions live in the provider's own ledger and must not be deleted
 * there, so they are filtered at read time instead. Matching is on the payment
 * id rather than on amount or currency: hiding "everything for ₹110" would also
 * hide a real ₹110 sale the day you start charging in INR.
 */
function excludedPaymentIds() {
  return new Set((process.env.PAYMENTS_EXCLUDE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * Payers to hide entirely, comma-separated in PAYMENTS_EXCLUDE_WHO — values as
 * they appear in the Who column, e.g. "discord:brokenlul". Case-insensitive.
 *
 * Same reasoning as excludedPaymentIds one level up: our own test purchases are
 * not customer revenue. Excluding the payer rather than the id is what makes it
 * stick — a handle is stable, whereas the id of the NEXT test purchase is not,
 * so an id-only rule silently lets the second one back into the customer feed.
 * There is no way to derive this from the data: the founder's beta_testers row
 * is named "founder", while checkout records whatever handle was typed into it.
 */
function excludedPayers() {
  return new Set((process.env.PAYMENTS_EXCLUDE_WHO || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

async function loadPayments() {
  if (_payCache.data && Date.now() - _payCache.at < PROVIDER_TTL) return _payCache.data;
  const [dodo, moon] = await Promise.all([fetchDodo(), fetchMoonpay()]);
  const excluded = excludedPaymentIds();
  const excludedWho = excludedPayers();
  const payments = [...dodo.payments, ...moon.payments]
    .filter((p) => p.created_at)
    .filter((p) => !p.id || !excluded.has(String(p.id)))
    .filter((p) => !p.who || !excludedWho.has(String(p.who).toLowerCase()))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const data = {
    payments,
    dodoSubs: dodo.subs || [],
    ok: dodo.ok || moon.ok,
    dodoOk: dodo.ok,
    moonOk: moon.ok,
    dodoFailures: dodo.failures || [],
    moonFailures: moon.failures || [],
  };
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
  sb, loadUsage, loadTesters, loadFeedback, loadSafetyEvents, loadSiteEvents, loadGuilds, loadActivity, loadUserConversations, loadUserProfile,
  loadGuildLabels, saveGuildLabel, loadHeartbeat, loadSentimentEvents, loadConversationsByMessageIds,
  loadAttribution, loadLabels, saveLabels, setAccess,
  loadPayments, classify, tierPrice, inferBilling, overviewMetrics, guildAccess, TIER, DAY, TRIAL_DAYS,
};
