# Pip Beta Dashboard

A single zero-dependency Vercel serverless function that renders live beta
analytics from the bot's Supabase `usage_log` table. Server-side only — the
Supabase secret key never reaches the browser.

## What it shows
- **Spend today / cap** and **messages today / cap** with progress meters (turns
  amber at 50%, clay at 80% = degrade mode).
- Active testers today vs. invited allowlist size.
- 7-day spend, message count, **avg cost per answer**, and **cache hit rate**.
- Spend-by-day chart, avg latency, degrade-mode count.
- Per-tester table (msgs / spend / searches / scans / charts) and top tools.

## Deploy (from this folder)
```
cd pip-dashboard
npx vercel            # first run links/creates the project
npx vercel --prod     # deploy to production
```
Or import `pip-dashboard/` as a new project in the Vercel dashboard.

## Environment variables (set in Vercel → Project → Settings → Environment Variables)
| Var | Value |
|---|---|
| `SUPABASE_URL` | `https://czwxjeowjexhlyjzfezl.supabase.co` |
| `SUPABASE_SECRET_KEY` | the `sb_secret_…` key (same one the bot uses) |
| `DASHBOARD_TOKEN` | **required** — any long random string; then open `…/?key=<token>`. The page fails closed: if this is unset, the dashboard serves nothing (it uses the Supabase service key, so this token is the only access control). |
| `BETA_DAILY_SPEND_USD` | `18` (must match the bot, for the cap meter) |
| `BETA_DAILY_GLOBAL_MSGS` | `350` |

The page auto-refreshes every 60s. It is read-only; it never writes to the DB.
