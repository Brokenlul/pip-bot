// Shared shell, styling, formatting, and cookie-auth helpers for the Pip admin
// console. Zero dependencies (Node built-ins only) so the whole dashboard stays
// build-free on Vercel.
const crypto = require('node:crypto');

// ---- auth ------------------------------------------------------------------
// The console reads every user's data with the Supabase service key, so access
// is the only thing between the URL and that data. Two ways in, both constant-
// time: a signed cookie (set by the /login page) or the legacy ?key=<token>
// (kept so existing bookmarks/automation still work). Fails closed.
const COOKIE_NAME = 'pipadmin';
const COOKIE_TAG = 'pip-admin-v1';

function dashToken() { return process.env.DASHBOARD_TOKEN || ''; }
function adminPassword() { return process.env.ADMIN_PASSWORD || process.env.DASHBOARD_TOKEN || ''; }

// Cookie value = HMAC(DASHBOARD_TOKEN, tag). Reusing the token as the signing key
// means no extra secret to manage; rotating the token invalidates old sessions.
function cookieValue() {
  const secret = dashToken();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(COOKIE_TAG).digest('hex');
}
function eq(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function parseCookies(req) {
  const raw = (req.headers && req.headers.cookie) || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isAuthed(req) {
  const token = dashToken();
  if (!token) return false; // fail closed
  const key = (req.query && req.query.key) || '';
  if (key && eq(key, token)) return true;
  const c = parseCookies(req)[COOKIE_NAME];
  return Boolean(c) && eq(c, cookieValue());
}
function passwordOk(provided) {
  const p = adminPassword();
  return Boolean(p) && eq(provided, p);
}
function loginCookieHeader() {
  // 7-day session; Secure + HttpOnly + SameSite=Lax.
  return `${COOKIE_NAME}=${cookieValue()}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Lax`;
}
function logoutCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// ---- formatting ------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const usd4 = (n) => `$${(Number(n) || 0).toFixed(4)}`;
const pct = (n) => `${Math.round((Number(n) || 0) * 100)}%`;
const dayKey = (iso) => String(iso).slice(0, 10);
const shortId = (id) => { const s = String(id); return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s; };
// Safe YYYY-MM-DD. Postgres 'infinity' (never-expires) parses to an invalid Date
// whose toISOString() throws — return ∞ for that, — for null.
const ymd = (iso) => { if (!iso) return '—'; const t = new Date(iso).getTime(); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '∞'; };
const ago = (iso) => {
  if (!iso) return '—';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(d)) return '—';
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};
/**
 * Time left until an access window closes, as "1d 5h" / "5h 20m" / "12m".
 *
 * Built for outreach: a date tells you when someone lapses, a countdown tells
 * you whether to message them now. Days+hours down to the last day, then
 * hours+minutes, because the last few hours are the ones worth acting on.
 *
 * Returns { text, cls, ms } so callers can colour by urgency, and guards
 * Postgres 'infinity' (comped/founder rows) — new Date('infinity') is Invalid,
 * and .toISOString() on it THROWS, which is why ymd() guards it too.
 */
const remaining = (iso, now = Date.now()) => {
  if (!iso) return { text: '—', cls: 'muted', ms: null };
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return { text: 'never expires', cls: 'ok', ms: Infinity };

  const ms = t - now;
  if (ms <= 0) {
    const d = Math.floor(-ms / 86400000);
    const h = Math.floor((-ms % 86400000) / 3600000);
    return { text: d >= 1 ? `expired ${d}d ago` : h >= 1 ? `expired ${h}h ago` : 'expired just now', cls: 'bad', ms };
  }
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  const text = days >= 1 ? `${days}d ${hours}h` : hours >= 1 ? `${hours}h ${mins}m` : `${mins}m`;
  // <24h is the "message them today" band, <72h the "queue them up" band.
  const cls = ms < 86400000 ? 'bad' : ms < 3 * 86400000 ? 'gold' : '';
  return { text, cls, ms };
};

/** Countdown as ready-to-drop HTML, with the exact date on hover. */
const untilCell = (iso, now) => {
  const r = remaining(iso, now);
  const title = iso && Number.isFinite(new Date(iso).getTime()) ? ` title="${esc(String(iso))}"` : '';
  return `<span class="${r.cls}"${title}>${esc(r.text)}</span>`;
};

const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const p95 = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };

// ---- shell -----------------------------------------------------------------
const NAV = [
  ['overview', 'Overview'],
  ['funnel', 'Funnel'],
  ['users', 'Users'],
  ['payments', 'Payments'],
  ['activity', 'Activity'],
  ['errors', 'Errors'],
];

function nav(active) {
  return `<nav class="tabs">${NAV.map(([id, label]) =>
    `<a href="/${id}" class="${active === id ? 'on' : ''}">${label}</a>`).join('')}<span class="spacer"></span><a href="/logout" class="muted">Sign out</a></nav>`;
}

function send(res, code, html, extraHeaders) {
  res.statusCode = code;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(html);
}

function shell(opts) {
  const { title, active, body, updated, refresh } = opts;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="60">' : ''}
<title>${esc(title)}</title><style>${CSS}</style></head><body><div class="wrap">
<header><div class="brand">pip<span class="dot"></span> · admin</div><div class="muted">${updated ? `as of ${new Date(updated).toISOString().slice(11, 16)} UTC${refresh ? ' · 60s' : ''}` : ''}</div></header>
${active ? nav(active) : ''}
${body}</div></body></html>`;
}

const CSS = `
:root{--mist:#F2F7EE;--paper:#FFF;--ink:#08160F;--body:#14342A;--sage:#5C6E63;--green:#12A15A;--clay:#C25B37;--gold:#C98A1E;--hair:#D8E6D3}
*{box-sizing:border-box}body{margin:0;background:var(--mist);color:var(--body);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:24px 20px 60px}
header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:16px}
.brand{font-weight:600;font-size:22px;color:var(--ink);letter-spacing:-.02em}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--green);margin-left:2px}
.tabs{display:flex;gap:4px;align-items:center;margin-bottom:20px;border-bottom:1px solid var(--hair);flex-wrap:wrap}
.tabs a{padding:8px 14px;color:var(--sage);text-decoration:none;font-weight:500;font-size:14px;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs a.on{color:var(--ink);border-bottom-color:var(--green)}.tabs a:hover{color:var(--ink)}.tabs .spacer{flex:1}
.muted{color:var(--sage)}.clay,.bad{color:var(--clay)}.ok{color:var(--green)}.gold{color:var(--gold)}
.eyebrow{font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--sage);margin-bottom:12px}
.card{background:var(--paper);border:1px solid var(--hair);border-radius:16px;padding:18px 20px;box-shadow:0 1px 2px rgba(14,59,38,.05),0 8px 24px rgba(14,59,38,.04);margin-bottom:14px;overflow-x:auto}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.grid3 .card,.grid4 .card,.grid2 .card{margin-bottom:0}
.stat .big,.big{font-size:28px;font-weight:600;color:var(--ink);letter-spacing:-.02em}
.meter{height:8px;background:var(--hair);border-radius:99px;overflow:hidden;margin:12px 0 8px}.fill{height:100%;border-radius:99px}
.chart{display:flex;align-items:flex-end;gap:10px;height:150px;padding-top:8px}.col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px}
.bar{width:100%;max-width:52px;background:var(--green);border-radius:6px 6px 0 0}.tick{font:11px ui-monospace,monospace;color:var(--sage)}
table{width:100%;border-collapse:collapse}th{text-align:left;font:12px/1 ui-monospace,monospace;text-transform:uppercase;letter-spacing:.06em;color:var(--sage);padding:8px 10px;border-bottom:1px solid var(--hair)}
td{padding:9px 10px;border-bottom:1px solid var(--hair);vertical-align:middle}tr:last-child td{border-bottom:none}
.mono{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--body)}
.tag{font:11px ui-monospace,monospace;padding:2px 8px;border-radius:99px;border:1px solid var(--hair)}
.tag.founder{color:#8a5a00;border-color:#e6d3a0;background:#fbf3dd}.tag.tester,.tag.paid{color:var(--green);border-color:#bfe6cd;background:#eef8f1}.tag.guest{color:var(--sage)}
.tag.trial{color:var(--gold);border-color:#e6d3a0;background:#fbf3dd}.tag.lapsed{color:var(--clay);border-color:#e6c3b5;background:#f9ede8}
a.rowlink{color:var(--body);text-decoration:none}a.rowlink:hover{color:var(--green)}
input,button{font:15px inherit;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.input{padding:10px 12px;border:1px solid var(--hair);border-radius:10px;outline:none;width:100%;background:#fff}.input:focus{border-color:var(--green)}
.btn{background:var(--green);color:#fff;border:none;padding:11px 18px;border-radius:10px;font-weight:600;cursor:pointer}.btn:hover{background:#0e8a4c}
.pill{display:inline-block;font:11px ui-monospace,monospace;color:var(--sage);border:1px solid var(--hair);border-radius:99px;padding:2px 8px;margin-right:6px}
a.pill{text-decoration:none}
a.pill.on{background:var(--sage);color:#fff;border-color:var(--sage)}
/* CRM row controls: the status dropdown saves on change, so it is colour-coded
   to be readable at a glance down the column rather than needing a legend. */
select.status{background:transparent;border:1px solid var(--hair);border-radius:99px;color:var(--sage);padding:2px 8px;font:11px ui-monospace,monospace;cursor:pointer}
select.status option{background:var(--paper);color:var(--ink)}
select.s-dead-lead{color:var(--sage);opacity:.6}
select.s-warm{color:var(--gold);border-color:var(--gold)}
select.s-hot{color:var(--clay);border-color:var(--clay)}
select.s-extended{color:var(--sage);border-color:var(--sage)}
select.s-revenue{color:var(--green);border-color:var(--green)}
.trunc{max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:820px){.grid3,.grid4,.grid2{grid-template-columns:1fr 1fr}.trunc{max-width:220px}}@media(max-width:520px){.grid3,.grid4,.grid2{grid-template-columns:1fr}}
`;

module.exports = {
  COOKIE_NAME, isAuthed, passwordOk, loginCookieHeader, logoutCookieHeader, dashToken,
  esc, usd, usd4, pct, dayKey, shortId, ago, median, p95,
  ymd, remaining, untilCell, send, shell, nav, CSS,
};
