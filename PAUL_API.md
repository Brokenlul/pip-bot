# Companion API (for Paulbot)

A small, **read-only, API-key-gated** surface on the existing dashboard app so an
external trading-companion bot (Paulbot, on Discord/Telegram) can pull the market
**understanding** this system produces — without ever touching trades, secrets, or
the proprietary signal logic.

Base URL (prod): `https://ai-wealth-manager-nu.vercel.app`
All companion routes live under `/api/paul/`.

---

## What it deliberately does NOT expose

- No exchange / LLM / Supabase keys, and no ability to place, modify, or cancel
  orders or touch the wealth manager. It only reads.
- No ranked component scores, weights, thresholds, level maths, MACD/RSI rules,
  or per-asset entries/stops/targets. Those are the IP — Paul gets qualitative
  *understanding*, not the signal a user could reverse-engineer.
- No "buy/sell now" calls. Every payload carries a `disclaimer`; it's context,
  not financial advice.

## Auth

Gated by its **own** key (separate from the dashboard's `admin` login), so you can
hand Paul a key and rotate/revoke it without affecting the dashboard.

- Set `PAUL_API_KEYS` on the server (comma-separated — list several to rotate
  with no downtime). **With no keys set, the data endpoints return `503`** — it's
  fail-closed, never accidentally world-open.
- Present the key as either header:
  - `Authorization: Bearer <key>`  or
  - `X-API-Key: <key>`

Generate a key:

```sh
.venv/bin/python -c "import secrets; print('paul_' + secrets.token_urlsafe(32))"
```

Set it on Vercel (prod) — repeat for Preview if Paul hits a preview URL:

```sh
vercel env add PAUL_API_KEYS production
# paste: paul_key_one,paul_key_two     (comma-separated; no spaces needed)
vercel deploy --prod
```

Rotating: add the new key to the list, deploy, switch Paul to it, then remove the
old key and deploy again.

## Endpoints

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/api/paul/health` | none | liveness + whether a key is required |
| GET | `/api/paul/market` | key | latest qualitative market read (prose) + regime |
| GET | `/api/paul/strategies` | key | coarse posture + return % per live strategy |
| GET | `/api/paul/ranking` | key | **Strategy 1** — per-coin L/S ranking: trend, crowd positioning, sentiment/news, volatility |
| GET | `/api/paul/directional` | key | **Strategy 2** — Aaryan directional read (per-coin thesis vs levels/trend) |

### `GET /api/paul/ranking` (Strategy 1 — how we read each coin)

Every coin scored on trend, crowd positioning (funding/OI/premium), and
sentiment/news, then ranked; top/bottom quartile = the long/short basket. Each
dimension carries a qualitative `read` alongside the score — the weights,
thresholds, and composite formula stay hidden.

```json
{
  "as_of": "2026-07-02T12:00:03+00:00",
  "strategy": "Dollar-neutral long/short (cross-sectional rank)",
  "ranking": [
    {"rank": 1, "asset": "SOL", "standing": 71.2, "basket": "long",
     "trend": {"score": 78, "read": "strong"},
     "crowd_positioning": {"score": 62, "read": "constructive"},
     "sentiment_news": {"score": 55, "read": "constructive"},
     "volatility": {"score": 60, "read": "constructive"}}
  ]
}
```

### `GET /api/paul/directional` (Strategy 2 — Aaryan's read)

The plain-English thesis behind each open directional position — how the coin
sits versus its key levels/trend. Prose only; no entry/stop/target or level maths.

```json
{
  "strategy": "Aaryan directional (levels + trend, per coin)",
  "reads": [
    {"asset": "BTC", "lean": "short", "read": "Rejecting the reclaimed level; momentum rolling over on the 4H."}
  ]
}
```

### `GET /api/paul/market`

```json
{
  "as_of": "2026-07-02T12:00:03+00:00",
  "as_of_ist": "2026-07-02 17:30:03 IST",
  "headline": "Market read",
  "market_read": "BTC is holding above the reclaimed level with momentum stabilizing ...",
  "regime": "risk-off / range",
  "disclaimer": "Educational market context ... Not financial advice ..."
}
```

### `GET /api/paul/strategies`

```json
{
  "as_of": "2026-07-02T12:00:03+00:00",
  "strategies": [
    {"name": "Dollar-neutral long/short", "posture": "net short", "return_pct": -0.03},
    {"name": "Directional (levels + trend)", "posture": "net long", "return_pct": -3.41}
  ],
  "disclaimer": "..."
}
```

## Calling it from Paul

```sh
curl -s https://ai-wealth-manager-nu.vercel.app/api/paul/market \
  -H "Authorization: Bearer $PAUL_API_KEY"
```

```python
import os, httpx
BASE = "https://ai-wealth-manager-nu.vercel.app"
h = {"Authorization": f"Bearer {os.environ['PAUL_API_KEY']}"}
market = httpx.get(f"{BASE}/api/paul/market", headers=h, timeout=10).json()
# feed market["market_read"] + market["regime"] into Paul's own prompt as context.
```

## Notes / future

- The market read is sourced from what the system already publishes to Supabase
  (prose narrative + regime), so this endpoint adds no live-compute cost or new
  secrets to the web function.
- No rate limiting yet (serverless makes in-process limits unreliable). If Paul
  gets busy or public, front it with a gateway limit (e.g. Vercel/edge) or add a
  Supabase/Upstash-backed limiter keyed on the API key.
- Want richer live trend / support-resistance context (computed on demand rather
  than the last published read)? That's a follow-up — it means importing the
  read-only market math into the web function; say the word.
