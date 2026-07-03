// Pip Beta Dashboard — a single zero-dependency Vercel serverless function that
// reads usage_log + feedback + beta_testers from Supabase (server-side, service
// key never leaves the function) and renders the pilot success metrics, with
// founder vs tester vs guest differentiation. Auto-refreshes every 60s.
//
// Env: SUPABASE_URL, SUPABASE_SECRET_KEY (required); FOUNDER_DISCORD_ID,
// DASHBOARD_TOKEN, BETA_ENDS_AT, BETA_DAILY_SPEND_USD, BETA_DAILY_GLOBAL_MSGS.

const crypto = require('node:crypto');

// Fail-closed gate. The dashboard reads all beta data with the Supabase service
// key (bypasses RLS), so this token is the ONLY thing protecting user_id /
// guild_id / spend from anyone who finds the URL. If DASHBOARD_TOKEN is not set
// we deny access rather than serving everything, and the compare is constant-time.
function tokenOk(provided, expected) {
  if (!expected) return false; // no token configured → no access (fail closed)
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const SPEND_CAP = Number(process.env.BETA_DAILY_SPEND_USD || 18);
const MSG_CAP = Number(process.env.BETA_DAILY_GLOBAL_MSGS || 350);
const FOUNDER_KEYS = new Set(
  [
    process.env.FOUNDER_DISCORD_ID ? `discord:${process.env.FOUNDER_DISCORD_ID}` : null,
    process.env.FOUNDER_TELEGRAM_ID ? `telegram:${process.env.FOUNDER_TELEGRAM_ID}` : null,
  ].filter(Boolean),
);
const isFounder = (k) => FOUNDER_KEYS.has(k);
const BETA_ENDS = process.env.BETA_ENDS_AT ? new Date(process.env.BETA_ENDS_AT) : null;

module.exports = async function handler(req, res) {
  const token = process.env.DASHBOARD_TOKEN;
  if (!tokenOk(req.query.key || '', token)) {
    const msg = token
      ? `Add <code>?key=…</code> to view.`
      : `Dashboard is locked. Set <code>DASHBOARD_TOKEN</code> in the environment, then open <code>?key=…</code>.`;
    return send(res, token ? 401 : 503, page('Locked', `<div class="card"><p class="muted">${msg}</p></div>`));
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return send(res, 500, page('Config', `<div class="card"><p class="muted">Set SUPABASE_URL and SUPABASE_SECRET_KEY in Vercel.</p></div>`));
  }

  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  let rows = [], testers = [], feedback = [];
  try {
    rows = await sb(url, key, `usage_log?select=created_at,platform,user_id,guild_id,cost_usd,tools_used,had_vision,web_searches,degraded,cache_hit,latency_ms,failed&created_at=gte.${weekAgo}&order=created_at.desc&limit=50000`);
    testers = await sb(url, key, `beta_testers?select=platform,platform_id`);
    feedback = await sb(url, key, `feedback?select=platform,rater_id,rating&created_at=gte.${weekAgo}`);
  } catch (e) {
    // Log the real cause server-side; don't render Supabase/Postgres error text
    // (can leak schema detail) to the page.
    console.error('[dashboard] Supabase query failed:', e && e.message ? e.message : e);
    return send(res, 502, page('Error', `<div class="card"><p class="clay">Could not load analytics right now. Check the server logs.</p></div>`));
  }

  res.setHeader('cache-control', 'no-store');
  send(res, 200, render(metrics(rows, testers, feedback)));
};

// ---- Supabase REST ---------------------------------------------------------
async function sb(url, key, path) {
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  return r.json();
}
function send(res, code, html) {
  res.statusCode = code;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
}

// ---- Metrics ---------------------------------------------------------------
const dayKey = (iso) => iso.slice(0, 10);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const p95 = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };

function metrics(rows, testers, feedback) {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const testerSet = new Set(testers.map((t) => `${t.platform}:${t.platform_id}`));
  const roleOf = (r) => { const k = `${r.platform}:${r.user_id}`; return isFounder(k) ? 'founder' : testerSet.has(k) ? 'tester' : 'guest'; };
  for (const r of rows) r._role = roleOf(r);

  const sum = (a, f) => a.reduce((s, r) => s + (Number(f(r)) || 0), 0);
  const today = rows.filter((r) => r.created_at >= dayStart);
  const spendByRole = (role) => sum(today.filter((r) => r._role === role), (r) => r.cost_usd);

  // surface split (today)
  const dm = today.filter((r) => String(r.guild_id).startsWith('dm:'));
  const srv = today.filter((r) => !String(r.guild_id).startsWith('dm:'));

  // ---- pilot metrics over TESTERS only -----------------------------------
  const tRows = rows.filter((r) => r._role === 'tester');
  const totalTesters = testerSet.size;
  const byTester = new Map();
  for (const r of tRows) {
    const k = `${r.platform}:${r.user_id}`;
    const u = byTester.get(k) || { rows: [], days: new Set(), firstAt: r.created_at };
    u.rows.push(r);
    u.days.add(dayKey(r.created_at));
    if (r.created_at < u.firstAt) u.firstAt = r.created_at;
    byTester.set(k, u);
  }
  const activeTesters = [...byTester.values()];

  // Activation: asked ≥3 in first 48h since their first message.
  const activated = activeTesters.filter((u) => {
    const cut = new Date(new Date(u.firstAt).getTime() + 48 * 3600e3).toISOString();
    return u.rows.filter((r) => r.created_at <= cut).length >= 3;
  });
  const activationPct = totalTesters ? activated.length / totalTesters : null;

  // Engagement: median questions per (tester, active day).
  const perUserDay = new Map();
  for (const r of tRows) { const k = `${r.platform}:${r.user_id}|${dayKey(r.created_at)}`; perUserDay.set(k, (perUserDay.get(k) || 0) + 1); }
  const engagement = median([...perUserDay.values()]);

  // Retention: median active days out of 7 (across active testers).
  const retentionDays = median(activeTesters.map((u) => u.days.size));

  // Day-7 / latest-day return: of activated testers, % active on the last day.
  const lastDay = dayKey((BETA_ENDS && BETA_ENDS < now ? new Date(BETA_ENDS - 1) : now).toISOString());
  const returned = activated.filter((u) => u.days.has(lastDay)).length;
  const day7 = activated.length ? returned / activated.length : null;

  // Quality: 👍/👎 from tester raters.
  const tFeed = feedback.filter((f) => { const k = `${f.platform}:${f.rater_id}`; return !isFounder(k) && testerSet.has(k); });
  const up = tFeed.filter((f) => f.rating === 'up').length;
  const down = tFeed.filter((f) => f.rating === 'down').length;
  const quality = up + down ? up / (up + down) : null;

  // Failed rate + ops (testers).
  const failedRate = tRows.length ? tRows.filter((r) => r.failed).length / tRows.length : null;
  const nonHit = tRows.filter((r) => !r.cache_hit);
  const costPerMsg = tRows.length ? sum(tRows, (r) => r.cost_usd) / tRows.length : null;
  const lat = nonHit.map((r) => Number(r.latency_ms) || 0).filter((x) => x > 0);
  const p95Latency = p95(lat);

  // week rollups (all roles)
  const weekSpend = sum(rows, (r) => r.cost_usd);
  const cacheHits = rows.filter((r) => r.cache_hit).length;
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    days.push({ day: d, spend: sum(rows.filter((r) => dayKey(r.created_at) === d), (r) => r.cost_usd) });
  }

  // per-user table (today), with role
  const byUserToday = new Map();
  for (const r of today) {
    const u = byUserToday.get(`${r.platform}:${r.user_id}`) || { id: r.user_id, role: r._role, msgs: 0, spend: 0, searches: 0, scans: 0, vision: 0 };
    u.msgs++; u.spend += Number(r.cost_usd) || 0; u.searches += Number(r.web_searches) || 0;
    u.scans += (r.tools_used || []).includes('token_scan') ? 1 : 0; u.vision += r.had_vision ? 1 : 0;
    byUserToday.set(`${r.platform}:${r.user_id}`, u);
  }
  const usersToday = [...byUserToday.values()].sort((a, b) => b.spend - a.spend);

  const tools = new Map();
  for (const r of rows) for (const t of r.tools_used || []) tools.set(t, (tools.get(t) || 0) + 1);
  const topTools = [...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  return {
    updated: now,
    todaySpend: sum(today, (r) => r.cost_usd), todayMsgs: today.length,
    activeTestersToday: new Set(today.filter((r) => r._role === 'tester').map((r) => r.user_id)).size,
    totalTesters,
    spend: { founder: spendByRole('founder'), tester: spendByRole('tester'), guest: spendByRole('guest') },
    surface: { dm: dm.length, srv: srv.length, dmSpend: sum(dm, (r) => r.cost_usd), srvSpend: sum(srv, (r) => r.cost_usd) },
    weekSpend, weekMsgs: rows.length, cacheRate: rows.length ? cacheHits / rows.length : 0,
    days, usersToday, topTools,
    up, down,
    stack: [
      metricRow('Activation', 'Asked ≥3 questions in first 48h', activationPct == null ? '—' : `${activated.length}/${totalTesters} · ${pct(activationPct)}`, activationPct != null && activationPct >= 0.8, '≥80%'),
      metricRow('Engagement', 'Median questions / user / active day', engagement == null ? '—' : engagement.toFixed(1), engagement != null && engagement >= 5 && engagement <= 8, '5–8'),
      metricRow('Retention', 'Median active days out of 7', retentionDays == null ? '—' : retentionDays.toFixed(1), retentionDays != null && retentionDays >= 4, '≥4'),
      metricRow('Retention', 'Day-7 return (active on last day)', day7 == null ? '—' : pct(day7), day7 != null && day7 >= 0.5, '≥50%'),
      metricRow('Quality', '👍 / 👎 ratio on answers', quality == null ? '— (no votes yet)' : pct(quality), quality != null && quality >= 0.8, '≥80% positive'),
      metricRow('Quality', 'Failed / unanswerable rate', failedRate == null ? '—' : pct(failedRate), failedRate != null && failedRate < 0.1, '<10%'),
      metricRow('Ops', 'Actual cost / message', costPerMsg == null ? '—' : usd4(costPerMsg), costPerMsg != null && costPerMsg <= 0.06, '≤$0.06'),
      metricRow('Ops', 'p95 answer latency', p95Latency == null ? '—' : `${(p95Latency / 1000).toFixed(1)}s`, p95Latency != null && p95Latency < 10000, '<10s'),
    ],
  };
}
function metricRow(layer, metric, value, ok, target) { return { layer, metric, value, ok, target }; }

// ---- Render ----------------------------------------------------------------
const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const usd4 = (n) => `$${(Number(n) || 0).toFixed(4)}`;
const pct = (n) => `${Math.round((Number(n) || 0) * 100)}%`;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const barColor = (f) => (f >= 0.8 ? 'var(--clay)' : f >= 0.5 ? '#C98A1E' : 'var(--green)');
const roleTag = (r) => `<span class="tag ${r}">${r === 'founder' ? '♛ founder' : r === 'tester' ? 'tester' : 'guest'}</span>`;

function render(m) {
  const spendFrac = SPEND_CAP ? m.todaySpend / SPEND_CAP : 0;
  const msgFrac = MSG_CAP ? m.todayMsgs / MSG_CAP : 0;
  const maxDay = Math.max(0.01, ...m.days.map((d) => d.spend));

  const stat = (label, value, sub) => `<div class="card stat"><div class="eyebrow">${esc(label)}</div><div class="big">${value}</div>${sub ? `<div class="muted">${sub}</div>` : ''}</div>`;
  const meter = (label, frac, value, cap) => `
    <div class="card stat"><div class="eyebrow">${esc(label)}</div>
      <div class="big">${value}<span class="muted"> / ${cap}</span></div>
      <div class="meter"><div class="fill" style="width:${Math.min(100, frac * 100).toFixed(1)}%;background:${barColor(frac)}"></div></div>
      <div class="muted">${pct(frac)} of daily cap${frac >= 0.8 ? ' · degrade mode' : ''}</div></div>`;

  const stackRows = m.stack.map((s) => `
    <tr><td class="mono">${esc(s.layer)}</td><td>${s.metric}</td>
      <td class="${s.ok ? 'ok' : s.value.startsWith('—') ? 'muted' : 'bad'}"><b>${s.value}</b></td>
      <td class="muted">${esc(s.target)}</td>
      <td>${s.value.startsWith('—') ? '<span class="muted">·</span>' : s.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'}</td></tr>`).join('');

  const manual = [
    ['Love', 'Disappointment if Pip vanished ("very")', 'end survey', '≥40%'],
    ['WTP', 'Soft-commits — "lock founding price"', 'count', '≥6/25'],
    ['Virality', 'Unprompted screenshots / tweets / mentions', 'count artifacts', '≥5'],
    ['Virality', '"Can I add Pip to my other server?" asks', 'count', '≥3'],
  ].map((r) => `<tr><td class="mono">${r[0]}</td><td>${r[1]}</td><td class="muted">${r[2]}</td><td class="muted">${r[3]}</td></tr>`).join('');

  const userRows = m.usersToday.length
    ? m.usersToday.map((u) => `<tr><td class="mono">${esc(u.id)}</td><td>${roleTag(u.role)}</td><td>${u.msgs}</td><td>${usd4(u.spend)}</td><td>${u.searches}</td><td>${u.scans}</td><td>${u.vision}</td></tr>`).join('')
    : `<tr><td colspan="7" class="muted">No activity today.</td></tr>`;
  const toolRows = m.topTools.length
    ? m.topTools.map(([t, c]) => `<tr><td class="mono">${esc(t)}</td><td>${c}</td></tr>`).join('')
    : `<tr><td colspan="2" class="muted">No tool calls yet.</td></tr>`;

  const body = `
    <div class="grid3">
      ${meter('Spend today (all)', spendFrac, usd(m.todaySpend), usd(SPEND_CAP))}
      ${meter('Messages today (all)', msgFrac, String(m.todayMsgs), String(MSG_CAP))}
      ${stat('Active testers today', `${m.activeTestersToday}<span class="muted"> / ${m.totalTesters}</span>`, 'invited on the allowlist')}
    </div>

    <div class="card">
      <div class="eyebrow">Pilot metric stack · testers only (founder excluded)</div>
      <table><thead><tr><th>Layer</th><th>Metric</th><th>Now</th><th>Target</th><th></th></tr></thead><tbody>${stackRows}</tbody></table>
    </div>

    <div class="grid4">
      ${stat('Tester spend · today', usd(m.spend.tester))}
      ${stat('Founder spend · today', usd(m.spend.founder), 'excluded from metrics')}
      ${stat('Guest spend · today', usd(m.spend.guest), 'uninvited (should be $0)')}
      ${stat('Surface · today', `${m.surface.srv}<span class="muted"> srv</span> · ${m.surface.dm}<span class="muted"> dm</span>`, 'messages by surface')}
    </div>

    <div class="grid4">
      ${stat('Spend · 7d', usd(m.weekSpend))}
      ${stat('Messages · 7d', m.weekMsgs.toLocaleString())}
      ${stat('Cache hit rate', pct(m.cacheRate), 'served free')}
      ${stat('Votes · 7d', `<span class="ok">▲ ${m.up}</span> · <span class="bad">▼ ${m.down}</span>`, 'on Pip answers')}
    </div>

    <div class="card">
      <div class="eyebrow">Spend · last 7 days</div>
      <div class="chart">${m.days.map((d) => `<div class="col"><div class="bar" style="height:${Math.max(2, (d.spend / maxDay) * 120)}px" title="${usd(d.spend)}"></div><div class="tick">${d.day.slice(5)}</div></div>`).join('')}</div>
    </div>

    <div class="card">
      <div class="eyebrow">Per-tester · today</div>
      <table><thead><tr><th>User</th><th>Role</th><th>Msgs</th><th>Spend</th><th>Search</th><th>Scan</th><th>Chart</th></tr></thead><tbody>${userRows}</tbody></table>
    </div>

    <div class="grid2">
      <div class="card"><div class="eyebrow">Top tools · 7d</div><table><thead><tr><th>Tool</th><th>Calls</th></tr></thead><tbody>${toolRows}</tbody></table></div>
      <div class="card"><div class="eyebrow">Manual metrics · track by hand</div><table><thead><tr><th>Layer</th><th>Metric</th><th>How</th><th>Target</th></tr></thead><tbody>${manual}</tbody></table></div>
    </div>`;

  return page('Pip · Beta Dashboard', body, m.updated);
}

function page(title, body, updated) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="60">
<title>${esc(title)}</title><style>
:root{--mist:#F2F7EE;--paper:#FFF;--ink:#08160F;--body:#14342A;--sage:#5C6E63;--green:#12A15A;--clay:#C25B37;--hair:#D8E6D3}
*{box-sizing:border-box}body{margin:0;background:var(--mist);color:var(--body);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 60px}
header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:22px}
.brand{font-weight:600;font-size:22px;color:var(--ink);letter-spacing:-.02em}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--green);margin-left:2px}
.muted{color:var(--sage)}.clay,.bad{color:var(--clay)}.ok{color:var(--green)}
.eyebrow{font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--sage);margin-bottom:12px}
.card{background:var(--paper);border:1px solid var(--hair);border-radius:16px;padding:18px 20px;box-shadow:0 1px 2px rgba(14,59,38,.05),0 8px 24px rgba(14,59,38,.04);margin-bottom:14px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.grid3 .card,.grid4 .card,.grid2 .card{margin-bottom:0}
.stat .big,.big{font-size:28px;font-weight:600;color:var(--ink);letter-spacing:-.02em}
.meter{height:8px;background:var(--hair);border-radius:99px;overflow:hidden;margin:12px 0 8px}.fill{height:100%;border-radius:99px}
.chart{display:flex;align-items:flex-end;gap:12px;height:150px;padding-top:8px}.col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px}
.bar{width:100%;max-width:52px;background:var(--green);border-radius:6px 6px 0 0}.tick{font:11px ui-monospace,monospace;color:var(--sage)}
table{width:100%;border-collapse:collapse}th{text-align:left;font:12px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--sage);padding:8px 10px;border-bottom:1px solid var(--hair)}
td{padding:9px 10px;border-bottom:1px solid var(--hair);vertical-align:middle}tr:last-child td{border-bottom:none}
.mono{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--body)}
.tag{font:11px ui-monospace,monospace;padding:2px 8px;border-radius:99px;border:1px solid var(--hair)}.tag.founder{color:#8a5a00;border-color:#e6d3a0;background:#fbf3dd}.tag.tester{color:var(--green);border-color:#bfe6cd;background:#eef8f1}.tag.guest{color:var(--sage)}
@media(max-width:820px){.grid3,.grid4,.grid2{grid-template-columns:1fr 1fr}}@media(max-width:520px){.grid3,.grid4,.grid2{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<header><div class="brand">pip<span class="dot"></span> · beta dashboard</div><div class="muted">${updated ? `as of ${updated.toISOString().slice(11, 16)} UTC · refreshes 60s` : ''}</div></header>
${body}</div></body></html>`;
}
