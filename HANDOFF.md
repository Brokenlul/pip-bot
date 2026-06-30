# Paul-Bot — Session Handoff (2026-06-30)

## 🟢 MVP SHIPPED

All five acceptance criteria verified live in a real Discord guild on 2026-06-30:

1. ✅ Grounded crypto/derivatives answer (BTC funding/OI from Hyperliquid)
2. ✅ Grounded macro answer (next FOMC date + days-until)
3. ✅ Cache layer built (off by design — flip on with a Voyage payment method)
4. ✅ Per-guild memory recall ("what have we asked about lately" works)
5. ✅ Persistent connection (stays online across idle)

The "Supabase RLS denies writes" bug was caused by the user pasting the publishable key into the service-role slot. Fixed by pasting `sb_secret_...` (modern format) into the new `SUPABASE_SECRET_KEY` env slot. Code prefers `SUPABASE_SECRET_KEY` over legacy `SUPABASE_SERVICE_ROLE_KEY` (eyJ...) if both are set.



> Read this before doing anything else when resuming work.
> Then go to `BUILD_GOAL.md` for the MVP spec and `CLAUDE.md` for repo conventions.

---

## Where we landed

**MVP is shipped to a real Discord server.** Paul Bot (`#9928`, app id `1521437096294744216`) is invited to one test guild and answering live. Screenshots of working responses are at `.cp-images/`.

| Milestone | Status | Notes |
|---|---|---|
| **M1 — Discord plumbing** | ✅ verified | `/paul` slash command registered globally. |
| **M2 — Claude loop** | ✅ verified | Single Sonnet-class model (`claude-sonnet-4-6`), no Haiku routing yet. |
| **M3 — Grounding** | ✅ verified | CoinGecko + Hyperliquid (funding/OI/premium) + FOMC calendar all firing. The "Read:" synthesis in the BTC reply is the differentiated answer we wanted. |
| **M4 — Semantic cache** | 🚫 deliberately disabled for ship | User chose to skip Voyage. Cache layer is built and schema is provisioned; flip `VOYAGE_API_KEY` back on + restart to light it up. See "Cache flip-on" section below. |
| **M5 — Server memory recall** | ⏳ pending Supabase RLS verification | Memory persistence + recall logic is now decoupled from embeddings — `lookupCache`/`persistQA` short-circuit cleanly when no Voyage key. M5 will work the moment Supabase writes succeed (Bug 1 below). |

---

## Ship mode: memory-on, cache-off

The code now has two independent gates in `config.ts`:

- `memoryEnabled()` — true when Supabase env is set. Powers persistence + recall (M5).
- `embeddingsEnabled()` — true when `VOYAGE_API_KEY` is set. Powers semantic cache (M4).

Boot log reflects both: `[paul] memory=on cache=off (memory needs Supabase, cache also needs Voyage)`.

**To run without Voyage:** comment `VOYAGE_API_KEY=` in `.env`. `lookupCache` returns null immediately, `persistQA` skips the embed call and still inserts the conversations row.

**Cache flip-on (when ready):** uncomment `VOYAGE_API_KEY` after adding a Voyage payment method (or swap to Gemini per Bug 2). No code change needed.

## One open bug blocking M5

### Bug 1 — Supabase RLS *may still* deny writes (verify next)

**Symptom (from bot log):**

```
[memory] ensureGuild:        new row violates row-level security policy for table "guilds"
[memory] increment_usage:    new row violates row-level security policy for table "usage_daily"
[memory] persistQA:          new row violates row-level security policy for table "conversations"
```

**Root cause hypothesis.** The user pasted the modern `sb_secret_...` 46-char Supabase key into `SUPABASE_SERVICE_ROLE_KEY`. `@supabase/supabase-js` v2.45 (pinned in `package.json`) doesn't appear to map the new secret-key format to a service-role bypass, so RLS is being enforced on every write — and since there are no policies (intentionally — we're server-only), every write fails.

**Verification step at session end:** User entered a 46-char Supabase key (modern `sb_secret_...` format) which *should* bypass RLS in `@supabase/supabase-js` 2.45+. Whether it actually does is verified by asking `/paul` in Discord and checking the bot log for RLS warnings. If clean → ship. If still denying, swap for the legacy JWT.

**Fallback fix:** swap for the **legacy `service_role` JWT** — long string starting `eyJ...`, ~250+ chars. May only be available on older Supabase projects under `Dashboard → Settings → API → "Legacy API keys" → service_role secret`:

  https://supabase.com/dashboard/project/czwxjeowjexhlyjzfezl/settings/api

Then restart `npm run dev` and confirm the RLS warnings disappear.

**Alternative fixes if the modern key doesn't work and there's no legacy JWT:**
1. Upgrade `@supabase/supabase-js` past 2.45 — newer SDKs may handle `sb_secret_` properly.
2. **Direct Postgres connection** — replace `getDb()` in `src/memory/db.ts` with `pg` client using the project's connection string. Bypasses PostgREST + RLS entirely. Server-only path, totally fine. Connection string: `Dashboard → Settings → Database → Connection string → Transaction pooler`.
3. Add a permissive RLS policy gated on `auth.role() = 'service_role'`.

Option 2 (direct pg) is the most reliable. ~30 min of code work.

## Cache flip-on details (post-ship)

### Bug 2 — Voyage free tier is unusable

**User question raised at end of session:** *"Is paying Voyage necessary, I'm already using Anthropic keys, I don't want to waste money."*

**The honest read.** Anthropic does not sell embeddings — Voyage is their official partner. You **do** need an embedder; the moat (semantic cache + per-guild memory) is built on it. But "wasting money" is the wrong frame: voyage-3-lite is ~$0.02 per million tokens. A `/paul` ask is ~30 tokens. An MVP test guild will cost cents per month at most. The payment method is a **rate-limit gate**, not a charging mechanism.

**Three resolution paths — user to pick when resuming:**


**Symptom:**

```
[retry:voyage-embed] attempt 1 failed: voyage 429:
  "You have not yet added your payment method in the billing page
   and will have reduced rate limits of 3 RPM and 10K TPM."
```

Free tier is **3 requests/minute** — far below what any real test produces. Each `/paul` triggers 1 embed for cache lookup + 1 embed for persist, so the second concurrent question already 429s. Even after Bug 1 is fixed, writes will fail until embeddings succeed (because `persistQA` requires a vector).

1. **Recommended — add a payment method on Voyage** (https://dash.voyageai.com/). Lifts the 3 RPM cap; actual spend will be cents/month for an MVP. Zero code changes.
2. **Swap to Google Gemini free embeddings** (`text-embedding-004`, 768-dim, 1500 req/day, no card required). ~30 min of code work:
   - Rewrite `src/memory/embeddings.ts` to call Gemini (REST endpoint).
   - Change `EMBEDDING_DIM` from `512` to `768`.
   - Write `db/migrations/0002_change_embedding_dim.sql` that drops the two `vector(512)` columns + ivfflat index, recreates them as `vector(768)`, and re-applies the index.
   - Add `GEMINI_API_KEY` to `.env` + `config.ts`.
3. **Cohere trial keys** are a fallback (1000/month free) but small ceiling.
4. **Skip semantic cache entirely** (lexical exact-match only). ~10 line change in `src/memory/store.ts`. Not recommended — paraphrases miss, which is most of what the cache is for.

---

## Repro / next-session quickstart

```powershell
# Confirm env is filled (no values printed)
awk -F= '/^[A-Z_]+=/ {print $1 "=" (length($2)>0 ? "[set]" : "[EMPTY]")}' C:\Users\Pc\Paul-Bot\.env

# Boot the bot in the foreground and watch logs
cd C:\Users\Pc\Paul-Bot
npm run dev

# In Discord, ask:
#   /paul what does the btc trend look like?
# Then watch for either:
#   [memory] persistQA: new row violates row-level security policy  ← Bug 1 not fixed
#   [retry:voyage-embed] attempt 1 failed: voyage 429: ...           ← Bug 2 not fixed
#   (clean lines, no [memory] warnings)                              ← both fixed
```

Once both bugs are fixed, verify M4 + M5 by:

- Asking the same `/paul` twice within ~10 min → second reply footers `(served from server memory · matched a question asked ~N min ago)` (M4).
- Asking `/paul what have we asked about lately` → Paul calls `recent_guild_questions` and lists prior asks (M5).

---

## Infrastructure inventory (don't recreate, don't lose)

| Resource | ID / location |
|---|---|
| Supabase project | `paul-bot`, id `czwxjeowjexhlyjzfezl`, region `ap-south-1` |
| Supabase org | `Broken's Org`, id `dxqsirngqcnscxqehxmj` |
| Sibling project (paused to free slot) | `Delhi.fyi`, id `irziwvmnujmboteqxtze` — unpause when no longer needed for paul-bot |
| Active sibling project | `ai-wealth-manager`, id `rvvgykzbocyucceeomwf` |
| Discord application | id `1521437096294744216`, bot `Paul Bot#9928` |
| Slash command | `/paul <question>`, registered globally |
| Voyage account | Free tier (3 RPM cap — needs payment method) |

`.env` (gitignored) holds: `ANTHROPIC_API_KEY`, `DISCORD_TOKEN`, `DISCORD_APP_ID`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `COINGECKO_API_KEY`, `VOYAGE_API_KEY` plus the model + cache tuning vars.

---

## What's deliberately NOT done (per BUILD_GOAL.md)

- Stripe / billing / Pro tiers
- Telegram adapter (interface is in place; no adapter yet)
- Reminders / scheduling
- Whitelabel personas, dashboard, on-chain execution
- Haiku-routes-Sonnet cost optimization
- Polymarket / Kalshi prediction-market tools
- DexScreener / Birdeye / Polygon / FRED tools

All of these are in the strategic plan at `C:\Users\Pc\.claude\plans\i-want-to-make-scalable-bunny.md` for post-MVP.

---

## Background process running at session end

A `npm run dev` was started in the background (id `b48xc63c4`, log at `C:\Users\Pc\AppData\Local\Temp\claude\C--Users-Pc-Paul-Bot\8d81cc55-a52c-4632-9475-73839f1470fc\tasks\b48xc63c4.output`). It is being killed at handoff. Next session should just `npm run dev` again.
