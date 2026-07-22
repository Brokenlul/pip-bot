// Pip admin console — a single zero-dependency Vercel function that routes to
// six server-rendered views (overview, payments, trials, activity, users,
// errors) behind a cookie login. Reads Supabase + the Dodo/MoonPay payment
// APIs server-side; keys never reach the browser.
const R = require('./_render.js');
const D = require('./_data.js');

const FOUNDER_KEYS = new Set([
  process.env.FOUNDER_DISCORD_ID ? `discord:${process.env.FOUNDER_DISCORD_ID}` : null,
  process.env.FOUNDER_TELEGRAM_ID ? `telegram:${process.env.FOUNDER_TELEGRAM_ID}` : null,
].filter(Boolean));
const CAPS = {
  spend: Number(process.env.BETA_DAILY_SPEND_USD || 18),
  msgs: Number(process.env.BETA_DAILY_GLOBAL_MSGS || 350),
};

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  req.query = req.query || Object.fromEntries(url.searchParams);

  // ---- auth-free routes ----
  if (path === '/login') {
    if ((req.method || 'GET').toUpperCase() === 'POST') {
      const body = await readBody(req);
      const password = new URLSearchParams(body).get('password') || '';
      if (R.passwordOk(password)) {
        res.statusCode = 302;
        res.setHeader('set-cookie', R.loginCookieHeader());
        res.setHeader('location', '/');
        return res.end();
      }
      return R.send(res, 401, loginPage('Wrong password.'));
    }
    return R.send(res, 200, loginPage());
  }
  if (path === '/logout') {
    res.statusCode = 302;
    res.setHeader('set-cookie', R.logoutCookieHeader());
    res.setHeader('location', '/login');
    return res.end();
  }

  // ---- gate ----
  if (!R.isAuthed(req)) {
    res.statusCode = 302;
    res.setHeader('location', '/login');
    return res.end();
  }

  // ---- CRM writes. POST-then-redirect so a refresh can't replay the action.
  if (path === '/people/label' || path === '/people/access') {
    if ((req.method || 'GET').toUpperCase() !== 'POST') {
      res.statusCode = 405;
      return res.end('method not allowed');
    }
    const form = new URLSearchParams(await readBody(req));
    const platform = form.get('platform') || '';
    const id = form.get('id') || '';
    if (!platform || !id) {
      res.statusCode = 400;
      return res.end('bad request');
    }
    try {
      if (path === '/people/label') {
        const labels = (form.get('labels') || '')
          .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 12);
        await D.saveLabels(platform, id, labels, form.get('note'));
      } else {
        const days = Math.max(0, Math.min(365, Number(form.get('days') || 0)));
        const until = await D.setAccess(platform, id, days);
        console.log(`[admin] access ${days === 0 ? 'revoked' : `+${days}d`} for ${platform}:${id} → ${until}`);
      }
    } catch (e) {
      console.error('[admin] CRM write failed:', e && e.message ? e.message : e);
      return R.send(res, 502, R.shell({
        title: 'Error', active: 'people',
        body: `<div class="card"><p class="bad">That change did not save. Nothing was modified. Check the server logs.</p><p><a href="/people">Back to People</a></p></div>`,
      }));
    }
    res.statusCode = 303; // 303 so the browser re-GETs instead of re-POSTing
    res.setHeader('location', req.headers.referer && req.headers.referer.includes('/people') ? req.headers.referer : '/people');
    return res.end();
  }

  const view = path === '/' ? 'overview' : path.slice(1);
  try {
    switch (view) {
      case 'people': return R.send(res, 200, await viewPeople(req.query.filter));
      case 'overview': return R.send(res, 200, await viewOverview());
      case 'funnel': return R.send(res, 200, await viewFunnel());
      case 'payments': return R.send(res, 200, await viewPayments());
      case 'trials': return R.send(res, 200, await viewTrials());
      case 'activity': return R.send(res, 200, await viewActivity());
      case 'users': return R.send(res, 200, await viewUsers(req.query.id, req.query.q));
      case 'errors': return R.send(res, 200, await viewErrors());
      default:
        return R.send(res, 404, R.shell({ title: 'Not found', active: '', body: `<div class="card"><p class="muted">No such view.</p></div>` }));
    }
  } catch (e) {
    console.error('[admin] view error:', e && e.message ? e.message : e);
    return R.send(res, 502, R.shell({ title: 'Error', active: view, body: `<div class="card"><p class="bad">Could not load this view right now. Check the server logs.</p></div>` }));
  }
};

// ---- body reader (works on Vercel's parsed body and raw dev-server stream) --
async function readBody(req) {
  if (req.body != null) {
    if (typeof req.body === 'string') return req.body;
    if (typeof req.body === 'object') return new URLSearchParams(req.body).toString();
  }
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); req.on('error', () => resolve(''));
  });
}

// ---- small render helpers --------------------------------------------------
const { esc, usd, usd4, pct, shortId, ago, ymd } = R;
const card = (eyebrow, inner) => `<div class="card"><div class="eyebrow">${esc(eyebrow)}</div>${inner}</div>`;
const stat = (label, value, sub) => `<div class="card stat"><div class="eyebrow">${esc(label)}</div><div class="big">${value}</div>${sub ? `<div class="muted">${sub}</div>` : ''}</div>`;
const table = (heads, rows) => `<table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${heads.length}" class="muted">Nothing yet.</td></tr>`}</tbody></table>`;
const barColor = (f) => (f >= 0.8 ? 'var(--clay)' : f >= 0.5 ? 'var(--gold)' : 'var(--green)');
function subTag(kind) { return `<span class="tag ${kind}">${kind}</span>`; }

// ---- login -----------------------------------------------------------------
function loginPage(err) {
  return R.shell({
    title: 'pip · admin — sign in', active: '',
    body: `<div style="max-width:360px;margin:8vh auto 0"><div class="card">
      <div class="eyebrow">Admin access</div>
      ${err ? `<p class="bad" style="margin:0 0 12px">${esc(err)}</p>` : ''}
      <form method="POST" action="/login" style="display:flex;flex-direction:column;gap:12px">
        <input class="input" type="password" name="password" placeholder="Admin password" autofocus autocomplete="current-password">
        <button class="btn" type="submit">Sign in</button>
      </form>
      <p class="muted" style="margin:12px 0 0;font-size:12.5px">This console shows private user + payment data. Founder only.</p>
    </div></div>`,
  });
}

// ---- 1. Overview -----------------------------------------------------------
async function viewOverview() {
  const [rows, testers, feedback] = await Promise.all([D.loadUsage(7), D.loadTesters(), D.loadFeedback(7)]);
  const m = D.overviewMetrics(rows, testers, feedback, CAPS, FOUNDER_KEYS);
  const spendFrac = CAPS.spend ? m.todaySpend / CAPS.spend : 0;
  const msgFrac = CAPS.msgs ? m.todayMsgs / CAPS.msgs : 0;
  const maxDay = Math.max(0.01, ...m.days.map((d) => d.spend));
  const meter = (label, frac, value, cap) => `<div class="card stat"><div class="eyebrow">${label}</div><div class="big">${value}<span class="muted"> / ${cap}</span></div><div class="meter"><div class="fill" style="width:${Math.min(100, frac * 100).toFixed(1)}%;background:${barColor(frac)}"></div></div><div class="muted">${pct(frac)} of daily cap${frac >= 0.8 ? ' · degrade' : ''}</div></div>`;
  const stackRows = m.stack.map(([layer, metric, value, ok, target]) =>
    `<tr><td class="mono">${layer}</td><td>${metric}</td><td class="${ok ? 'ok' : String(value).startsWith('—') ? 'muted' : 'bad'}"><b>${value}</b></td><td class="muted">${target}</td><td>${String(value).startsWith('—') ? '<span class="muted">·</span>' : ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'}</td></tr>`).join('');
  const toolRows = m.topTools.map(([t, c]) => `<tr><td class="mono">${esc(t)}</td><td>${c}</td></tr>`).join('');
  const body = `
    <div class="grid3">
      ${meter('Spend today', spendFrac, usd(m.todaySpend), usd(CAPS.spend))}
      ${meter('Messages today', msgFrac, String(m.todayMsgs), String(CAPS.msgs))}
      ${stat('Active testers today', `${m.activeTestersToday}<span class="muted"> / ${m.totalTesters}</span>`, 'on the allowlist')}
    </div>
    ${card('Pilot metric stack · testers only (founder excluded)', table(['Layer', 'Metric', 'Now', 'Target', ''], stackRows))}
    <div class="grid4">
      ${stat('Tester spend · today', usd(m.spend.tester))}
      ${stat('Founder spend · today', usd(m.spend.founder), 'excluded')}
      ${stat('Guest spend · today', usd(m.spend.guest), 'should be $0')}
      ${stat('Surface · today', `${m.surface.srv}<span class="muted"> srv</span> · ${m.surface.dm}<span class="muted"> dm</span>`)}
    </div>
    <div class="grid4">
      ${stat('Spend · 7d', usd(m.weekSpend))}
      ${stat('Messages · 7d', m.weekMsgs.toLocaleString())}
      ${stat('Cache hit rate', pct(m.cacheRate), 'served free')}
      ${stat('Votes · 7d', `<span class="ok">▲ ${m.up}</span> · <span class="bad">▼ ${m.down}</span>`)}
    </div>
    ${card('Spend · last 7 days', `<div class="chart">${m.days.map((d) => `<div class="col"><div class="bar" style="height:${Math.max(2, (d.spend / maxDay) * 120)}px" title="${usd(d.spend)}"></div><div class="tick">${d.day.slice(5)}</div></div>`).join('')}</div>`)}
    ${card('Top tools · 7d', table(['Tool', 'Calls'], toolRows))}`;
  return R.shell({ title: 'pip · admin — overview', active: 'overview', body, updated: m.updated, refresh: true });
}

// ---- 2. Payments & revenue -------------------------------------------------
async function viewPayments() {
  const [pay, testers] = await Promise.all([D.loadPayments(), D.loadTesters()]);
  const now = Date.now();
  const paidTesters = testers.filter((t) => D.classify(t, now) === 'paid');
  const churned = testers.filter((t) => t.subscription_provider && D.classify(t, now) === 'lapsed');
  // MRR estimate from active paid subs (billing inferred from window length).
  const mrr = paidTesters.reduce((s, t) => s + D.tierPrice(t.tier, D.inferBilling(t)), 0);
  const rev = (days) => { const cut = now - days * D.DAY; return pay.payments.filter((p) => new Date(p.created_at).getTime() >= cut).reduce((s, p) => s + (Number(p.amount) || 0), 0); };
  const provSplit = { dodo: paidTesters.filter((t) => t.subscription_provider === 'dodo').length, moonpay: paidTesters.filter((t) => t.subscription_provider === 'moonpay').length, loop: paidTesters.filter((t) => t.subscription_provider === 'loop').length };
  const feed = pay.payments.slice(0, 40).map((p) =>
    `<tr><td class="muted">${ago(p.created_at)}</td><td><span class="pill">${esc(p.provider)}</span></td><td>${usd(p.amount)} <span class="muted">${esc(p.currency)}</span></td><td class="mono">${esc(p.who || '—')}</td><td class="muted">${esc(p.status || '')}</td><td class="mono muted" style="font-size:11px">${esc(p.id || '—')}</td></tr>`).join('');
  const subRows = paidTesters.map((t) =>
    `<tr><td class="mono">${esc(t.name || t.platform_id)}</td><td><span class="pill">${esc(t.subscription_provider || '?')}</span></td><td>${esc((D.TIER[t.tier] || {}).label || t.tier || '—')}</td><td>${esc(D.inferBilling(t))}</td><td class="muted">${ymd(t.access_until)}</td></tr>`).join('');
  const providersDown = (!pay.dodoOk || !pay.moonOk) ? `<p class="muted" style="margin:0 0 10px;font-size:12.5px">${pay.dodoOk ? '' : 'Dodo API unreachable. '}${pay.moonOk ? '' : 'MoonPay API unreachable.'} Showing what's available.</p>` : '';
  const body = `
    ${providersDown}
    <div class="grid4">
      ${stat('Active subscribers', String(paidTesters.length), 'status = active')}
      ${stat('MRR (est.)', usd(mrr), 'active subs × plan price')}
      ${stat('Revenue · 30d', usd(rev(30)), 'from provider payments')}
      ${stat('Churned', String(churned.length), 'had a sub, now lapsed')}
    </div>
    <div class="grid3">
      ${stat('Revenue · 7d', usd(rev(7)))}
      ${stat('Revenue · all', usd(rev(3650)))}
      ${stat('By provider', `${provSplit.moonpay} <span class="muted">moonpay</span> · ${provSplit.dodo} <span class="muted">dodo</span>${provSplit.loop ? ` · ${provSplit.loop} loop` : ''}`)}
    </div>
    ${card('Recent payments · live from Dodo + MoonPay', table(['When', 'Provider', 'Amount', 'Who', 'Status', 'Payment id'], feed)
      + `<p class="muted" style="margin-top:8px">Test transactions live in the provider's ledger and are not deleted from it. To hide one here, add its payment id to <code>PAYMENTS_EXCLUDE_IDS</code> (comma-separated) in the Vercel env.</p>`)}
    ${card('Active subscriptions', table(['User', 'Provider', 'Plan', 'Billing', 'Renews'], subRows))}`;
  return R.shell({ title: 'pip · admin — payments', active: 'payments', body, updated: new Date() });
}

// ---- 3. Trials & conversions ----------------------------------------------
async function viewTrials() {
  const testers = await D.loadTesters();
  const now = Date.now();
  const withState = testers.map((t) => ({ t, state: D.classify(t, now) }));
  const trials = withState.filter((x) => x.state === 'trial');
  const paid = withState.filter((x) => x.state === 'paid');
  const lapsed = withState.filter((x) => x.state === 'lapsed');
  const expiringSoon = trials.filter((x) => x.t.access_until && new Date(x.t.access_until).getTime() - now < 2 * D.DAY);
  const lapsedUnpaid = lapsed.filter((x) => !x.t.subscription_provider);
  const extended = testers.filter((t) => t.extension_used);
  const convBase = paid.length + lapsedUnpaid.length;
  const convRate = convBase ? paid.length / convBase : null;

  const trialRows = trials.sort((a, b) => new Date(a.t.access_until || 0) - new Date(b.t.access_until || 0)).map((x) => {
    const ends = x.t.access_until ? new Date(x.t.access_until).getTime() : null;
    const left = ends ? Math.max(0, Math.round((ends - now) / D.DAY)) : '∞';
    const soon = ends && ends - now < 2 * D.DAY;
    return `<tr><td class="mono">${esc(x.t.name || x.t.platform_id)}</td><td><span class="pill">${esc(x.t.platform)}</span></td><td class="${soon ? 'bad' : ''}">${left}${left === '∞' ? '' : 'd'} left</td><td class="muted">${ymd(x.t.access_until)}</td><td>${x.t.extension_used ? '<span class="gold">extended</span>' : ''}</td></tr>`;
  }).join('');
  const lapsedRows = lapsedUnpaid.map((x) =>
    `<tr><td class="mono">${esc(x.t.name || x.t.platform_id)}</td><td><span class="pill">${esc(x.t.platform)}</span></td><td class="muted">${ymd(x.t.access_until)}</td><td>${x.t.extension_used ? 'used ext' : 'no ext'}</td></tr>`).join('');
  const extRows = extended.map((t) =>
    `<tr><td class="mono">${esc(t.name || t.platform_id)}</td><td class="muted">${t.extension_claimed_at ? ago(t.extension_claimed_at) : '—'}</td><td>${t.extension_tweet_url ? `<a class="rowlink" href="${esc(t.extension_tweet_url)}" target="_blank" rel="noopener">tweet ↗</a>` : '<span class="muted">no link</span>'}</td></tr>`).join('');

  const body = `
    <div class="grid4">
      ${stat('On trial now', String(trials.length))}
      ${stat('Expiring ≤48h', String(expiringSoon.length), expiringSoon.length ? 'reach out' : '')}
      ${stat('Lapsed (unpaid)', String(lapsedUnpaid.length))}
      ${stat('Trial → paid', convRate == null ? '—' : pct(convRate), `${paid.length} paid / ${convBase} decided`)}
    </div>
    ${card('On trial now · soonest to expire first', table(['User', 'Platform', 'Left', 'Ends', ''], trialRows))}
    ${card('Tweet extensions claimed · verify the links', table(['User', 'Claimed', 'Tweet'], extRows))}
    ${card('Lapsed & unpaid · re-engage or let go', table(['User', 'Platform', 'Ended', 'Extension'], lapsedRows))}`;
  return R.shell({ title: 'pip · admin — trials', active: 'trials', body, updated: new Date() });
}

// ---- 3b. Funnel (website -> bot) -------------------------------------------
// Answers the launch-day question: are people arriving, and do any of them go
// on to actually use Pip? The website half comes from site_events (first-party,
// see db/migrations/0012_site_events.sql); the bot half from the tables we
// already had. The two halves are counted over the same window and shown as
// one drop-off chain.
//
// Honest caveat, worth remembering when reading this page: a website visitor is
// anonymous, so "clicked add-bot" and "started using Pip" are matched at the
// COHORT level (same 7-day window), not per person. The percentages are
// directional, not a per-user join.
// ---- People (CRM) ----------------------------------------------------------
// One row per PERSON, not per tester. A community joiner who never messaged has
// no beta_testers row at all, and those unconverted leads are the whole reason
// this view exists — the Users view can't see them.
async function viewPeople(filter) {
  const now = Date.now();
  const [testers, usage, claims, labels] = await Promise.all([
    D.loadTesters(), D.loadUsage(90), D.loadAttribution(), D.loadLabels(),
  ]);

  const key = (p, id) => `${p}:${id}`;
  const people = new Map();
  const upsert = (platform, platformId) => {
    const k = key(platform, platformId);
    if (!people.has(k)) {
      people.set(k, {
        platform, platformId, name: null, source: null, visitorId: null,
        firstSeen: null, joinedAt: null, msgs: 0, lastActive: null, spend: 0,
        accessUntil: undefined, paid: false, labels: [], note: null,
      });
    }
    return people.get(k);
  };

  for (const t of testers) {
    const p = upsert(t.platform, t.platform_id);
    p.name = t.name && t.name !== 'auto' && t.name !== 'granted' ? t.name : p.name;
    p.firstSeen = t.invited_at;
    p.accessUntil = t.access_until;
    p.paid = Boolean(t.subscription_provider) && (t.subscription_status || 'active') === 'active';
    p.tier = t.tier;
  }

  // Leads: claimed handoffs and community joins. These may have no tester row.
  for (const c of claims) {
    if (!c.platform_id) continue; // an add-bot claim identifies a guild, not a person
    const p = upsert(c.platform, c.platform_id);
    p.source = c.intent;
    p.visitorId = c.visitor_id || p.visitorId;
    p.joinedAt = c.claimed_at;
    if (!p.name && c.meta && c.meta.name) p.name = c.meta.name;
  }

  for (const u of usage) {
    const p = people.get(key(u.platform, String(u.user_id)));
    if (!p) continue;
    p.msgs += 1;
    p.spend += Number(u.cost_usd || 0);
    if (!p.lastActive || u.created_at > p.lastActive) p.lastActive = u.created_at;
  }

  for (const l of labels) {
    const p = people.get(key(l.platform, l.platform_id));
    if (p) { p.labels = l.labels || []; p.note = l.note; }
  }

  // Lifecycle stage. Ordered most-advanced first so the badge reads as progress.
  const stageOf = (p) => {
    if (p.paid) return 'paid';
    if (p.msgs === 0) return 'lead';           // arrived, never spoke
    const lapsed = p.accessUntil && Number.isFinite(new Date(p.accessUntil).getTime())
      && now > new Date(p.accessUntil).getTime();
    if (lapsed) return 'lapsed';
    const days = new Set(usage
      .filter((u) => String(u.user_id) === p.platformId)
      .map((u) => ymd(u.created_at)));
    return days.size >= 2 ? 'returned' : 'activated';
  };

  let rows = [...people.values()].map((p) => ({ ...p, stage: stageOf(p) }));
  if (FOUNDER_KEYS.size) rows = rows.filter((p) => !FOUNDER_KEYS.has(key(p.platform, p.platformId)));
  if (filter) rows = rows.filter((p) => p.stage === filter || p.labels.includes(filter));

  // Leads first (they need action), then by recency.
  const rank = { lead: 0, activated: 1, returned: 2, lapsed: 3, paid: 4 };
  rows.sort((a, b) =>
    rank[a.stage] - rank[b.stage] ||
    String(b.lastActive || b.joinedAt || b.firstSeen || '').localeCompare(String(a.lastActive || a.joinedAt || a.firstSeen || '')));

  const counts = rows.reduce((m, p) => ({ ...m, [p.stage]: (m[p.stage] || 0) + 1 }), {});
  const SOURCE_LABEL = {
    telegram: 'site → telegram', discord_bot: 'site → add-bot', discord_community: 'community join',
  };

  const body = rows.map((p) => {
    const id = `${p.platform}:${p.platformId}`;
    const lapsed = p.stage === 'lapsed';
    const until = p.accessUntil
      ? (Number.isFinite(new Date(p.accessUntil).getTime()) ? ymd(p.accessUntil) : 'never')
      : '—';
    return `<tr>
      <td>
        <div><strong>${esc(p.name || shortId(p.platformId))}</strong></div>
        <div class="muted mono" style="font-size:11px">${esc(id)}</div>
      </td>
      <td><span class="tag ${p.stage === 'paid' ? 'paid' : p.stage === 'lapsed' ? 'lapsed' : p.stage === 'lead' ? 'guest' : 'trial'}">${p.stage}</span></td>
      <td class="muted">${esc(SOURCE_LABEL[p.source] || '—')}${p.visitorId ? `<div class="mono" style="font-size:11px">visitor ${esc(p.visitorId.slice(0, 8))}…</div>` : ''}</td>
      <td class="mono">${p.msgs}</td>
      <td class="muted">${p.lastActive ? ago(p.lastActive) : '—'}</td>
      <td class="mono ${lapsed ? 'bad' : ''}">${until}</td>
      <td>${statusSelect(p)}</td>
      <td style="white-space:nowrap">
        ${accessForm(p, 7, '+7d')}
        ${accessForm(p, 0, 'revoke')}
      </td>
    </tr>`;
  }).join('');

  const chip = (label, value) =>
    `<a href="/people${value ? `?filter=${encodeURIComponent(value)}` : ''}" class="pill ${filter === value ? 'on' : ''}">${esc(label)}</a>`;

  return R.shell({
    title: 'pip · admin — people', active: 'people',
    body: `
      <div class="grid">
        ${stat('People', rows.length, 'excludes founder')}
        ${stat('Leads', counts.lead || 0, 'arrived, never messaged')}
        ${stat('Activated', (counts.activated || 0) + (counts.returned || 0), `${counts.returned || 0} came back another day`)}
        ${stat('Paid', counts.paid || 0, `${counts.lapsed || 0} lapsed`)}
      </div>
      ${card('Filter', `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        ${chip('all', '')}${chip('leads', 'lead')}${chip('activated', 'activated')}${chip('returned', 'returned')}${chip('lapsed', 'lapsed')}${chip('paid', 'paid')}
        <span class="muted" style="margin:0 4px">·</span>
        ${STATUSES.map((s) => chip(s, s)).join('')}
      </div>`)}
      ${card('People', table(
        ['Person', 'Stage', 'Source', 'Msgs', 'Last active', 'Access until', 'Status', 'Access'],
        body,
      ))}
      <div class="card"><p class="muted">
        A <strong>lead</strong> arrived but never sent a message. Source is only known where the
        handoff could carry a token: the community invite takes no per-visitor parameter, so those
        joins show as "community join" with no visitor. Extensions run from now, not from the old
        expiry, and never consume the user's tweet-for-a-week grant.
      </p></div>`,
  });
}

// Pipeline status. A fixed vocabulary rather than free text, so the filter
// chips and any later reporting can rely on the values actually matching.
const STATUSES = ['dead lead', 'warm', 'hot', 'extended', 'revenue'];

/**
 * Single-select status that saves on change, so tagging someone is one click.
 *
 * Stored in the same labels[] column, as a 0- or 1-element array. Any existing
 * value outside STATUSES (e.g. tags typed before this dropdown existed) is
 * carried as an extra option rather than silently dropped on the next save.
 */
function statusSelect(p) {
  const current = p.labels[0] || '';
  const options = STATUSES.includes(current) || !current ? STATUSES : [...STATUSES, current];
  return `<form method="POST" action="/people/label" style="display:inline">
    <input type="hidden" name="platform" value="${esc(p.platform)}">
    <input type="hidden" name="id" value="${esc(p.platformId)}">
    <select name="labels" class="status s-${esc(current.replace(/\s+/g, '-') || 'none')}" onchange="this.form.submit()">
      <option value=""${current ? '' : ' selected'}>—</option>
      ${options.map((s) =>
        `<option value="${esc(s)}"${s === current ? ' selected' : ''}>${esc(s)}</option>`).join('')}
    </select>
    <noscript><button class="btn" type="submit" style="font-size:11px">set</button></noscript>
  </form>`;
}

function accessForm(p, days, label) {
  return `<form method="POST" action="/people/access" style="display:inline">
    <input type="hidden" name="platform" value="${esc(p.platform)}">
    <input type="hidden" name="id" value="${esc(p.platformId)}">
    <input type="hidden" name="days" value="${days}">
    <button class="btn" type="submit" style="font-size:11px">${label}</button>
  </form>`;
}

async function viewFunnel() {
  const days = 7;
  const [events, testers, usage] = await Promise.all([
    D.loadSiteEvents(days), D.loadTesters(), D.loadUsage(days),
  ]);
  const since = Date.now() - days * D.DAY;

  const views = events.filter((e) => e.event === 'pageview');
  const uniq = (rows, key) => new Set(rows.map((r) => r[key])).size;
  const visitors = uniq(views, 'visitor_id');
  const sessions = uniq(views, 'session_id');

  const clicks = events.filter((e) => e.event === 'click');
  const clicksOf = (name) => uniq(clicks.filter((c) => c.target === name), 'visitor_id');
  const addBot = clicksOf('discord_add_bot');
  const community = clicksOf('discord_community');
  const telegram = clicksOf('telegram_bot');
  const reachedBot = addBot + community + telegram;

  const checkoutStart = uniq(events.filter((e) => e.event === 'checkout_start'), 'visitor_id');
  const checkoutSubmit = uniq(events.filter((e) => e.event === 'checkout_submit'), 'visitor_id');

  // Bot half. Every step here is scoped to the people who ENROLLED in this
  // window, otherwise the rates compare a 7-day cohort against all-time actives
  // and you get percentages over 100.
  const fresh = testers.filter((t) => new Date(t.invited_at).getTime() >= since);
  const freshIds = new Set(fresh.map((t) => t.platform_id));
  const newTesters = fresh.length;
  // Enrolment IS the first message (autoEnroll fires on first touch), so
  // "enrolled -> sent a message" would always be 100% and tell us nothing.
  // The honest second step is whether they ever came back on another day.
  const daysByUser = new Map();
  for (const u of usage) {
    const id = String(u.user_id);
    if (!freshIds.has(id)) continue;
    if (!daysByUser.has(id)) daysByUser.set(id, new Set());
    daysByUser.get(id).add(dayKeyOf(u.created_at));
  }
  const returned = [...daysByUser.values()].filter((s) => s.size >= 2).length;
  const newPaid = fresh.filter((t) => t.subscription_provider).length;
  // Everyone active in the window regardless of when they joined — headline
  // number, deliberately not used as a funnel denominator.
  const activeUsers = uniq(usage, 'user_id');

  const rate = (n, d) => (d ? pct(n / d) : '—');
  const step = (label, n, base, note) =>
    `<tr><td>${esc(label)}</td><td class="big" style="font-size:20px">${n}</td><td class="mono">${rate(n, base)}</td><td class="muted">${note || ''}</td></tr>`;

  const funnelRows = [
    step('Visited the site', visitors, visitors, `${views.length} pageviews · ${sessions} sessions`),
    step('Clicked through to Pip', reachedBot, visitors, `add-bot ${addBot} · community ${community} · telegram ${telegram}`),
    step('Opened checkout', checkoutStart, visitors, 'clicked a pricing CTA'),
    step('Reached payment', checkoutSubmit, checkoutStart, 'picked card or crypto'),
  ].join('');

  const botRows = [
    step('Started using Pip', newTesters, reachedBot || newTesters, 'first message = enrolment'),
    step('Came back another day', returned, newTesters, 'active on 2+ distinct days'),
    step('Paid', newPaid, newTesters, 'of the people who started this window'),
  ].join('');

  // Where they came from. referrer_host is the host only, never a full URL.
  const tally = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      const k = r[key] || (key === 'referrer_host' ? 'direct' : 'none');
      if (!m.has(k)) m.set(k, new Set());
      m.get(k).add(r.visitor_id);
    }
    return [...m.entries()].map(([k, set]) => [k, set.size]).sort((a, b) => b[1] - a[1]).slice(0, 12);
  };
  const refRows = tally(views, 'referrer_host').map(([k, n]) =>
    `<tr><td class="mono">${esc(k)}</td><td>${n}</td><td class="mono">${rate(n, visitors)}</td></tr>`).join('');
  const utmRows = tally(views.filter((v) => v.utm_source), 'utm_source').map(([k, n]) =>
    `<tr><td class="mono">${esc(k)}</td><td>${n}</td><td class="mono">${rate(n, visitors)}</td></tr>`).join('');
  const pageRows = tally(views, 'path').map(([k, n]) =>
    `<tr><td class="mono">${esc(k)}</td><td>${n}</td><td class="mono">${rate(n, visitors)}</td></tr>`).join('');
  const planRows = tally(events.filter((e) => e.event === 'checkout_start'), 'target').map(([k, n]) =>
    `<tr><td class="mono">${esc(k)}</td><td>${n}</td><td class="mono">${rate(n, checkoutStart)}</td></tr>`).join('');
  const countryRows = tally(views, 'country').map(([k, n]) =>
    `<tr><td class="mono">${esc(k)}</td><td>${n}</td><td class="mono">${rate(n, visitors)}</td></tr>`).join('');

  // Daily visitors, so launch day is legible at a glance.
  const byDay = new Map();
  for (const v of views) {
    const d = dayKeyOf(v.created_at);
    if (!byDay.has(d)) byDay.set(d, new Set());
    byDay.get(d).add(v.visitor_id);
  }
  const dayList = [...byDay.entries()].map(([d, s]) => [d, s.size]).sort((a, b) => a[0] < b[0] ? -1 : 1);
  const peak = Math.max(1, ...dayList.map(([, n]) => n));
  const chart = dayList.length
    ? `<div class="chart">${dayList.map(([d, n]) =>
        `<div class="col"><span class="tick">${n}</span><div class="bar" style="height:${Math.round((n / peak) * 100)}%"></div><span class="tick">${esc(d.slice(5))}</span></div>`).join('')}</div>`
    : '<p class="muted">No pageviews recorded yet.</p>';

  const mobile = uniq(views.filter((v) => v.device === 'mobile'), 'visitor_id');

  const empty = !events.length
    ? `<div class="card"><p class="bad">No site events yet.</p><p class="muted">If the site is live, check that db/migrations/0012_site_events.sql has been applied and that SUPABASE_URL + SUPABASE_SECRET_KEY are set on the <strong>pip-site</strong> Vercel project. Note the tracker honours Do Not Track, so a DNT browser records nothing by design.</p></div>`
    : '';

  const body = `
    ${empty}
    <div class="grid4">
      ${stat('Visitors · 7d', String(visitors), `${views.length} pageviews`)}
      ${stat('Clicked to Pip', String(reachedBot), rate(reachedBot, visitors) + ' of visitors')}
      ${stat('Messaged Pip', String(activeUsers), 'distinct users in usage_log')}
      ${stat('On mobile', visitors ? pct(mobile / visitors) : '—', `${mobile} visitors`)}
    </div>
    ${card('Website funnel · unique visitors, last 7 days', table(['Step', 'People', 'Rate', 'Detail'], funnelRows))}
    ${card('Bot funnel · cohort-level, NOT matched per person to the rows above', table(['Step', 'People', 'Rate', 'Detail'], botRows))}
    ${card('Daily visitors', chart)}
    <div class="grid2">
      ${card('Where they came from', table(['Referrer', 'Visitors', 'Share'], refRows))}
      ${card('Campaigns (utm_source)', table(['Source', 'Visitors', 'Share'], utmRows))}
    </div>
    <div class="grid2">
      ${card('Top pages', table(['Path', 'Visitors', 'Share'], pageRows))}
      ${card('Countries', table(['Country', 'Visitors', 'Share'], countryRows))}
    </div>
    ${card('Which plan CTA got clicked', table(['Plan', 'Visitors', 'Share of checkout opens'], planRows))}`;
  return R.shell({ title: 'pip · admin — funnel', active: 'funnel', body, updated: new Date(), refresh: true });
}

const dayKeyOf = (ts) => new Date(ts).toISOString().slice(0, 10);

// ---- 4. Activity feed ------------------------------------------------------
async function viewActivity() {
  const [rows, testers] = await Promise.all([D.loadActivity(100), D.loadTesters()]);
  const nameOf = new Map(testers.filter((t) => t.name).map((t) => [t.platform_id, t.name]));
  const feed = rows.map((r) => {
    const isDM = String(r.guild_id).startsWith('dm:');
    const who = nameOf.get(r.user_id) || shortId(r.user_id);
    return `<tr><td class="muted" style="white-space:nowrap">${ago(r.created_at)}</td>
      <td><a class="rowlink" href="/users?id=${encodeURIComponent(r.user_id)}">${esc(who)}</a></td>
      <td><span class="pill">${isDM ? 'DM' : 'srv'}</span></td>
      <td><div class="trunc" title="${esc(r.question)}">${esc(r.question || '—')}</div></td>
      <td><div class="trunc muted" title="${esc(r.answer)}">${esc((r.answer || '').replace(/\s+/g, ' ').slice(0, 160))}</div></td></tr>`;
  }).join('');
  const body = card('Live activity · last 100 questions (auto-refresh 60s)', table(['When', 'User', '', 'Question', 'Answer'], feed));
  return R.shell({ title: 'pip · admin — activity', active: 'activity', body, updated: new Date(), refresh: true });
}

// ---- 5. Users + drill-down -------------------------------------------------
async function viewUsers(id, q) {
  if (id) return viewUserDetail(id);
  const [testers, rows] = await Promise.all([D.loadTesters(), D.loadUsage(7)]);
  const now = Date.now();
  const spendBy = new Map(); const lastBy = new Map(); const msgBy = new Map();
  for (const r of rows) {
    spendBy.set(r.user_id, (spendBy.get(r.user_id) || 0) + (Number(r.cost_usd) || 0));
    msgBy.set(r.user_id, (msgBy.get(r.user_id) || 0) + 1);
    if (!lastBy.has(r.user_id) || r.created_at > lastBy.get(r.user_id)) lastBy.set(r.user_id, r.created_at);
  }
  const needle = (q || '').toLowerCase();
  const list = testers
    .filter((t) => !needle || String(t.name || '').toLowerCase().includes(needle) || String(t.platform_id).toLowerCase().includes(needle))
    .map((t) => ({ t, state: D.classify(t, now), last: lastBy.get(t.platform_id), spend: spendBy.get(t.platform_id) || 0, msgs: msgBy.get(t.platform_id) || 0 }))
    .sort((a, b) => (b.last || '').localeCompare(a.last || ''));
  const rowsHtml = list.map((x) =>
    `<tr><td><a class="rowlink mono" href="/users?id=${encodeURIComponent(x.t.platform_id)}">${esc(x.t.name || x.t.platform_id)}</a></td>
      <td><span class="pill">${esc(x.t.platform)}</span></td><td>${subTag(x.state)}</td>
      <td>${x.msgs}</td><td>${usd4(x.spend)}</td><td class="muted">${x.last ? ago(x.last) : '—'}</td></tr>`).join('');
  const body = `
    <div class="card"><form method="GET" action="/users" style="display:flex;gap:10px"><input class="input" name="q" placeholder="Search by name or id" value="${esc(q || '')}"><button class="btn" type="submit">Search</button></form></div>
    ${card(`Users · ${list.length}${needle ? ` matching “${esc(q)}”` : ''} (spend/msgs = last 7d)`, table(['User', 'Platform', 'State', 'Msgs 7d', 'Spend 7d', 'Last seen'], rowsHtml))}`;
  return R.shell({ title: 'pip · admin — users', active: 'users', body, updated: new Date() });
}

async function viewUserDetail(id) {
  const [testers, convos, profiles, rows] = await Promise.all([
    D.loadTesters(), D.loadUserConversations(id, 30), D.loadUserProfile(id), D.loadUsage(30),
  ]);
  const t = testers.find((x) => x.platform_id === id);
  const now = Date.now();
  const mine = rows.filter((r) => r.user_id === id);
  const spend = mine.reduce((s, r) => s + (Number(r.cost_usd) || 0), 0);
  const state = t ? D.classify(t, now) : 'unknown';
  const header = `<div class="card"><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <div class="big">${esc(t ? t.name || t.platform_id : shortId(id))}</div>
      ${t ? subTag(state) : ''}
      <span class="mono muted">${esc(id)}</span>
      <span class="spacer" style="flex:1"></span><a class="rowlink" href="/users">← all users</a></div></div>`;
  const info = `<div class="grid4">
      ${stat('State', t ? state : 'not a tester')}
      ${stat('Spend · 30d', usd(spend))}
      ${stat('Messages · 30d', String(mine.length))}
      ${stat('Access until', t && ymd(t.access_until), t && t.subscription_provider ? `${t.subscription_provider} · ${(D.TIER[t.tier] || {}).label || t.tier || ''}` : '')}
    </div>`;
  const profileHtml = profiles.length
    ? profiles.map((p) => `<div style="margin-bottom:10px"><div class="muted mono" style="font-size:12px">${esc(String(p.guild_id))} · ${ago(p.updated_at)}</div><div>${esc(p.profile)}</div></div>`).join('')
    : '<p class="muted">No learned profile yet.</p>';
  const convRows = convos.map((c) =>
    `<tr><td class="muted" style="white-space:nowrap">${ago(c.created_at)}</td><td><div class="trunc" title="${esc(c.question)}">${esc(c.question)}</div></td><td><div class="trunc muted" title="${esc(c.answer)}">${esc((c.answer || '').replace(/\s+/g, ' ').slice(0, 160))}</div></td></tr>`).join('');
  const body = `${header}${info}
    ${card('Learned profile (memory)', profileHtml)}
    ${card('Recent questions', table(['When', 'Question', 'Answer'], convRows))}`;
  return R.shell({ title: 'pip · admin — user', active: 'users', body, updated: new Date() });
}

// ---- 6. Errors & health ----------------------------------------------------
async function viewErrors() {
  const rows = await D.loadUsage(7);
  // Safety-backstop firings (durable channel, migration 0011). Best-effort:
  // an env whose DB predates the table shouldn't 500 the whole errors view.
  const safety = await D.loadSafetyEvents(7).catch(() => []);
  const failed = rows.filter((r) => r.failed);
  const failRate = rows.length ? failed.length / rows.length : 0;
  const degraded = rows.filter((r) => r.degraded).length;
  const lat = rows.filter((r) => !r.cache_hit).map((r) => Number(r.latency_ms) || 0).filter((x) => x > 0);
  const p95Lat = R.p95(lat);
  // failure rate per day
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * D.DAY).toISOString().slice(0, 10);
    const dayRows = rows.filter((r) => String(r.created_at).slice(0, 10) === d);
    const f = dayRows.length ? dayRows.filter((r) => r.failed).length / dayRows.length : 0;
    days.push({ day: d, f, n: dayRows.length });
  }
  const maxF = Math.max(0.01, ...days.map((d) => d.f));
  // group recent errors by detail prefix
  const byKind = new Map();
  for (const r of failed) {
    const k = (r.error_detail || 'unknown').split(' ')[0].slice(0, 60);
    byKind.set(k, (byKind.get(k) || 0) + 1);
  }
  const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const recent = failed.slice(0, 40).map((r) =>
    `<tr><td class="muted" style="white-space:nowrap">${ago(r.created_at)}</td><td><span class="pill">${esc(r.platform)}</span></td><td class="mono">${shortId(r.user_id)}</td><td><div class="trunc bad" title="${esc(r.error_detail || '')}">${esc(r.error_detail || 'unknown')}</div></td></tr>`).join('');
  const kindRows = kinds.map(([k, c]) => `<tr><td class="mono">${esc(k)}</td><td>${c}</td></tr>`).join('');
  // Safety events, mirrors the failures block: summary counts + a recent table.
  const leakCount = safety.filter((s) => s.kind === 'prompt_leak').length;
  const signalCount = safety.filter((s) => s.kind === 'signal_language').length;
  const safetyRecent = safety.slice(0, 30).map((s) =>
    `<tr><td class="muted" style="white-space:nowrap">${ago(s.created_at)}</td><td><span class="pill">${esc(s.platform)}</span></td><td class="mono">${shortId(s.user_id)}</td><td><span class="pill">${esc(s.kind)}</span></td><td><div class="trunc" title="${esc(s.detail || '')}">${esc(s.detail || '—')}</div></td></tr>`).join('');
  const body = `
    <div class="grid4">
      ${stat('Failure rate · 7d', pct(failRate), `${failed.length} / ${rows.length}`)}
      ${stat('p95 latency', p95Lat == null ? '—' : `${(p95Lat / 1000).toFixed(1)}s`, '<10s target')}
      ${stat('Degraded turns', String(degraded), 'budget ≥80%')}
      ${stat('Messages · 7d', rows.length.toLocaleString())}
    </div>
    ${card('Failure rate · last 7 days', `<div class="chart">${days.map((d) => `<div class="col"><div class="bar" style="height:${Math.max(2, (d.f / maxF) * 120)}px;background:${d.f > 0.1 ? 'var(--clay)' : 'var(--green)'}" title="${pct(d.f)} of ${d.n}"></div><div class="tick">${d.day.slice(5)}</div></div>`).join('')}</div>`)}
    <div class="grid2">
      ${card('Error kinds · 7d', table(['Kind', 'Count'], kindRows))}
      ${card('Health', `<table><tbody>
        <tr><td>Total failures</td><td class="${failed.length ? 'bad' : 'ok'}"><b>${failed.length}</b></td></tr>
        <tr><td>Timeouts</td><td>${failed.filter((r) => (r.error_detail || '').includes('timeout')).length}</td></tr>
        <tr><td>Rate-limits (429)</td><td>${failed.filter((r) => (r.error_detail || '').includes(':429')).length}</td></tr>
        <tr><td>Overloaded (5xx)</td><td>${failed.filter((r) => /overloaded|:5\d\d/.test(r.error_detail || '')).length}</td></tr>
      </tbody></table>`)}
    </div>
    ${card('Recent failures · error_detail', table(['When', 'Platform', 'User', 'Detail'], recent))}
    <div class="grid2">
      ${card('Safety backstops · 7d', `<table><tbody>
        <tr><td>Prompt-leak blocks</td><td class="${leakCount ? 'bad' : 'ok'}"><b>${leakCount}</b></td></tr>
        <tr><td>Signal-language slips</td><td>${signalCount}</td></tr>
        <tr><td>Total events</td><td>${safety.length}</td></tr>
      </tbody></table>`)}
      ${card('What these are', `<div class="muted" style="line-height:1.5">
        <b>Prompt-leak</b>: output matched a system-prompt signature and was hard-swapped for a safe refusal.<br>
        <b>Signal-language</b>: answer contained imperative "buy/sell now" phrasing — logged only, never rewritten.
      </div>`)}
    </div>
    ${card('Recent safety events', table(['When', 'Platform', 'User', 'Kind', 'Detail'], safetyRecent))}`;
  return R.shell({ title: 'pip · admin — errors', active: 'errors', body, updated: new Date(), refresh: true });
}
