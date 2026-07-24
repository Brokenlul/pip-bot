# Paul-Bot — CLAUDE.md

Conventions for any Claude Code session in this repo. Read `BUILD_GOAL.md` for the milestone-by-milestone spec.

## Stack (locked)

- Node.js 22+, TypeScript, ES modules.
- `discord.js` v14, `@anthropic-ai/sdk`, `@supabase/supabase-js`, `zod`, `p-retry`.
- Supabase (Postgres + pgvector) for memory and semantic cache. No Redis in MVP.
- Sonnet-class model for the answer (`ANSWER_MODEL`, default `claude-sonnet-4-6`). A conservative Haiku fast-path exists but is **OFF by default** (disabled 2026-07-24, same day it shipped): it answered "next fed meeting" from parametric memory with a wrong date and `tools_used: []`, and cost ~3x Sonnet because a per-model prompt cache never stays warm at its traffic share. Enable only via `SIMPLE_ROUTING_ENABLED=true`, and read the header comment in `src/core/route.ts` first. Calendar/next-event asks are permanently excluded from the cheap path. Keep any routing conservative — a mis-route to Haiku degrades the answer.

## Layout

```
src/
  index.ts                # process entrypoint — boots the Discord adapter
  config.ts               # typed env loader
  adapters/
    platform.ts           # PlatformAdapter interface (adapter-agnostic core)
    discord.ts            # discord.js implementation
  core/
    agent.ts              # Claude agent loop (tool use)
    formatter.ts          # NormalizedReply -> platform-agnostic embed payload
    sources.ts            # citation footer helpers
  data/
    registry.ts           # Tool registry consumed by agent
    coingecko.ts          # market data
    hyperliquid.ts        # funding + open interest (the differentiator)
    fed-calendar.ts       # hardcoded FOMC JSON
  memory/
    embeddings.ts         # embedding client
    store.ts              # Q&A persistence + semantic cache (Supabase)
    db.ts                 # Supabase typed client
  scripts/
    register-commands.ts  # registers /paul globally (or to DEV guild)
    migrate.ts            # applies SQL in db/migrations against Supabase
db/
  migrations/             # idempotent SQL applied in lexical order
```

## Rules

- **No `discord.js` types in `src/core/**`.** Core takes a `NormalizedMessage` and returns a `NormalizedReply`. The adapter does the translation.
- **Memory is read before the agent loop and written after every answer.** That's the moat habit — don't bolt it on at the end.
- **Every external API call** goes through `withRetry` + the provider's `withCache` helper. A flaky CoinGecko call must not crash a reply.
- **Every grounded answer cites its sources and a timestamp.** Wrong answers must be debuggable.
- **Disclaimer on every reply**: "Not financial advice. Sources: [...]. Data as of HH:MM UTC."
- **Secrets only in `.env`** — never committed. `.env.example` documents the keys.
- **Scope discipline**: anything not in `BUILD_GOAL.md`'s "In scope" gets a `// POST-MVP:` note instead of code.

## Verification

```
npm run typecheck       # passes
npm run register-commands  # one-off, after DISCORD_TOKEN + DISCORD_APP_ID set
npm run migrate         # applies db/migrations/*.sql to Supabase
npm run dev             # live reload locally
```

Five acceptance prompts in a real test guild (see `BUILD_GOAL.md`):
1. BTC funding right now
2. Next Fed meeting
3. Re-ask within 10 min → served from cache
4. "What have we asked about lately"
5. Bot stays connected across restarts/idle
