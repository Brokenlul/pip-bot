# Paul-Bot

> AI research analyst for crypto / finance / trading communities.
> `/paul <question>` → a grounded, source-cited answer backed by live market, derivatives, and macro data.

Built to the spec in [`BUILD_GOAL.md`](./BUILD_GOAL.md). Conventions live in [`CLAUDE.md`](./CLAUDE.md).

---

## What works today (MVP scope)

| Milestone | What it does | Verify with |
|---|---|---|
| **M1 — Plumbing** | Bot connects to Discord; `/paul <question>` returns a Discord embed. | `npm run register-commands && npm run dev` |
| **M2 — LLM loop** | `/paul` routes through Claude (single Sonnet-class model) with a tight analyst system prompt. | `/paul explain what funding rate is` |
| **M3 — Grounding** | Agent calls three live data tools: CoinGecko (price), **Hyperliquid (funding + OI)**, FOMC calendar. Embed footers cite every source + UTC timestamp. | `/paul what's BTC funding looking like right now` |
| **M4 — Memory + cache** | Supabase + pgvector. Every Q&A persisted per guild; semantic cache short-circuits near-identical re-asks within ~10 min. | Ask the same question twice; second reply footers `(served from server memory …)` |
| **M5 — Multi-tenant** | All memory/cache scoped by `guildId`. Per-guild daily question counter. `recent_guild_questions` tool answers *"what have we asked about lately"*. | `/paul what have we asked about lately` |

Out of MVP scope (deliberately not built): Stripe / billing, Telegram, reminders/scheduling, dashboards, on-chain execution. See `BUILD_GOAL.md`.

---

## Stack

- Node 22+ · TypeScript · ES modules
- `discord.js` v14 · `@anthropic-ai/sdk` · `@supabase/supabase-js` · `zod` · `p-retry`
- Supabase (Postgres + pgvector) — also the semantic cache (no Redis in MVP)
- Voyage AI for embeddings (`voyage-3-lite`, 512-dim — change the column dim in `db/migrations/0001_init.sql` if you swap models)

## Layout

```
src/
  index.ts                 # process entrypoint (Discord)
  config.ts                # typed env loader (zod)
  adapters/
    platform.ts            # PlatformAdapter interface + Normalized types
    discord.ts             # discord.js implementation
  core/
    agent.ts               # Claude agent loop (system prompt + tool use)
    formatter.ts           # Normalized reply formatter
    util.ts                # withRetry, in-memory cache
  data/
    registry.ts            # Tool registry consumed by the agent
    coingecko.ts           # crypto_price
    hyperliquid.ts         # crypto_perp_funding_and_oi  (the differentiator)
    fed-calendar.ts        # next_fomc_meeting
    memory-tool.ts         # recent_guild_questions  (M5 — server memory recall)
  memory/
    db.ts                  # Supabase client (no-op when env missing)
    embeddings.ts          # Voyage 512-dim embeddings
    store.ts               # lookupCache / persistQA / recentQuestions / incrementUsage
  scripts/
    register-commands.ts   # registers /paul globally or to a dev guild
    migrate.ts             # applies db/migrations/*.sql to Supabase
db/
  migrations/0001_init.sql # tables, pgvector index, RPCs
```

## Configure

```bash
cp .env.example .env
# fill in:
#   ANTHROPIC_API_KEY
#   DISCORD_TOKEN, DISCORD_APP_ID, (optional) DISCORD_DEV_GUILD_ID
#   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY      ← needed for M4 + M5
#   VOYAGE_API_KEY                                ← needed for M4 + M5
#   COINGECKO_API_KEY                             ← optional (free tier works without)
```

`memoryEnabled()` is `true` only when **all three** of `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `VOYAGE_API_KEY` are set. Until then, M1–M3 still work — memory writes become no-ops.

### Discord app setup (one-time)

1. https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → reset token → put it in `DISCORD_TOKEN`. Copy the application ID → `DISCORD_APP_ID`.
3. No privileged intents are required (slash commands don't need MessageContent intent).
4. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`; permissions: `Send Messages`, `Embed Links`, `Use Slash Commands`. Open the URL, invite to a test guild.
5. Copy that guild's ID into `DISCORD_DEV_GUILD_ID` for instant slash-command propagation while iterating.

### Supabase setup (only when you reach M4)

1. Create a project at supabase.com (free tier is fine).
2. Settings → API → copy `URL` and `service_role` key into `.env`.
3. Apply the schema:
   ```bash
   npm run migrate
   ```
   If the host doesn't expose the SQL execution endpoint, open the SQL editor and paste `db/migrations/0001_init.sql`. It's idempotent and re-runnable.

## Run

```bash
npm install
npm run typecheck          # sanity
npm run register-commands  # one-off; or any time you change the command shape
npm run dev                # live reload
# or for prod:
npm run build && npm start
```

The process must stay alive (Discord uses a long-lived gateway). Use Railway, Render, Fly.io, or a small VPS for deploy. **Vercel serverless will not work** for the bot runtime.

## Acceptance walkthrough (the five MVP criteria)

In a real test guild:

1. **`/paul what's BTC funding looking like right now`** → grounded reply citing **Hyperliquid (BTC-PERP)**. *Tests M3.*
2. **`/paul when is the next Fed meeting`** → upcoming FOMC date + days-until. *Tests M3.*
3. **Re-ask either of the above within ~10 min** → reply footers `(served from server memory · matched a question asked ~N min ago)`. *Tests M4.*
4. **`/paul what have we asked about lately`** → list of recent server questions. *Tests M5.*
5. Leave the process running idle → it stays connected; Discord shows the bot as online. *Tests M1 deployability.*

## Tuning knobs

- `SEMANTIC_CACHE_SIMILARITY` (default `0.92`): cosine threshold for cache hits. Too low → stale answers swap in. Too high → cache never hits.
- `SEMANTIC_CACHE_TTL_SECONDS` (default `600`): how long a cached answer is considered "fresh". Price-volatile questions should run shorter; thesis-style questions can run longer.
- `ANSWER_MODEL` (default `claude-sonnet-4-6`): single-model MVP. Don't add Haiku routing yet — `BUILD_GOAL.md` defers that.

## What's next (post-MVP, in order)

1. **Telegram adapter** (`grammY`, webhook) — drops in behind the existing `PlatformAdapter` interface.
2. **Reminders engine** — `events` table + `bullmq`; *"remind me 30m before FOMC"*.
3. **Derivative aggregator** — fan funding/OI across Binance + Bybit + Deribit alongside Hyperliquid.
4. **Prediction-market tool** — Polymarket/Kalshi odds fusion (the "market's pricing 78% cut" flavor).
5. **Conversion choreography** — DM the admin when their guild's daily counter hits its (then-introduced) cap.

The strategic teardown that motivates the order lives at `C:\Users\Pc\Downloads\Paul-Bot_Teardown.md`.
