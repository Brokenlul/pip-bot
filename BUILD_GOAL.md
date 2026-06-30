# Paul-Bot — MVP Build Goal

> Build **milestone by milestone**, in order. Do not skip ahead.
> Stop and verify each milestone in a real Discord server before starting the next.

---

## Objective (one sentence)

A Discord bot where a user types `/paul <question>` and gets a **grounded, accurate, up-to-date answer** backed by live market / macro / derivatives data (not the model's training set), with every Q&A written to **per-guild memory** so the bot gets more useful to a community over time.

The whole MVP exists to prove one thing: *grounded answers + per-community memory are genuinely better than a generic LLM in a server.*

---

## "Done" acceptance criteria

The MVP is done when, in a real Discord server:

1. `/paul what's BTC funding looking like right now` returns a correct, live, grounded answer within a few seconds.
2. `/paul when is the next Fed meeting` returns the correct upcoming date.
3. Asking the **same question again within ~10 minutes** is served from cache (no duplicate API/LLM spend).
4. Every Q&A is persisted **per guild**, and the bot can answer `/paul what have we asked about lately` from its own memory.
5. It runs as a persistent process and stays connected without manual restarts.

---

## In scope (the entire MVP — nothing more)

1. Discord adapter — discord.js, single slash command `/paul <question>`.
2. Agent core — Claude agent loop with tool calling.
3. Minimal data-tool set: CoinGecko price, Hyperliquid funding/OI, hardcoded FOMC calendar JSON.
4. Per-guild memory — Supabase (Postgres + pgvector): `(guild, user, question, answer, embedding, ts)`.
5. Semantic cache — before LLM/tools, check for near-identical recent question *for this guild*.
6. Response formatter — Discord embed (answer + sources used + timestamp).
7. Per-guild daily usage counter (no billing).

## OUT of scope

- ❌ Payments / billing / Pro tiers / Stripe / USDC
- ❌ Telegram adapter (architect for it, don't build it)
- ❌ Reminders / scheduling
- ❌ White-label personas, web dashboard, on-chain execution
- ❌ Every data source beyond the minimal set

## Tech stack (decisions are made — don't re-litigate)

- Node.js + TypeScript
- discord.js
- `@anthropic-ai/sdk`, tool use
- Supabase (Postgres + pgvector) — also serves as the semantic cache (no Redis in MVP)
- Embeddings: pick one and stay consistent
- Secrets only in `.env`

## Milestones

- **M1 — Plumbing.** Bot connects; `/paul <text>` echoes back.
- **M2 — LLM loop.** `/paul` answers via Claude (no tools).
- **M3 — Grounding.** Market + derivatives + Fed-calendar tools wired; agent calls them.
- **M4 — Memory + cache.** Supabase + pgvector; persist + semantic-cache check before answering.
- **M5 — Multi-tenant basics.** Per-guild scoping + daily usage counter.

## Guardrails

- Cache + retry around every external API call.
- Single Sonnet-class model — no Haiku-routes-Sonnet optimization yet.
- `paul-core` adapter-agnostic — no `discord.js` types in core.
- Every answer shows sources + timestamp.
- Post-MVP scope → leave a `// POST-MVP:` note and move on.
