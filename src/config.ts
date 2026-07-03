import 'dotenv/config';
import { z } from 'zod';

const Schema = z
  .object({
    ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
    // Discord is optional now that Telegram is a peer surface — but if either
    // Discord token slot is set, both must be (a half-configured adapter is a
    // silent no-op). At least one platform must be configured (refine below).
    DISCORD_TOKEN: z.string().optional(),
    DISCORD_APP_ID: z.string().optional(),
    DISCORD_DEV_GUILD_ID: z.string().optional(),

    // Telegram (https://t.me/BotFather → /newbot). Adapter loads only when set.
    TELEGRAM_BOT_TOKEN: z.string().optional(),

  SUPABASE_URL: z.string().url().optional(),
  // Two slots, both bypass RLS. Code picks whichever is set (SECRET_KEY first).
  SUPABASE_SECRET_KEY: z.string().optional(),        // modern: sb_secret_...
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),  // legacy JWT: eyJ...

  COINGECKO_API_KEY: z.string().optional(),
  FRED_API_KEY: z.string().optional(),
  VOYAGE_API_KEY: z.string().optional(),
  // Solana Tracker (data.solanatracker.io) — free tier, no card. Enriches
  // token_scan with per-token top-traders-by-PnL (the smart-money proxy).
  SOLANA_TRACKER_API_KEY: z.string().optional(),
  // Finnhub (finnhub.io) — free tier. Powers the equity tools: quote,
  // fundamentals/metrics, earnings surprises + calendar + recommendations.
  FINNHUB_API_KEY: z.string().optional(),
  // Financial Modeling Prep (financialmodelingprep.com) — free tier.
  // Full line-item income / balance / cash-flow statements.
  FMP_API_KEY: z.string().optional(),

  // AI Wealth Manager companion API (read-only market understanding).
  // Tools + ambient backdrop load only when PAUL_API_KEY is set.
  PAUL_API_BASE_URL: z.string().url().default('https://ai-wealth-manager-nu.vercel.app'),
  PAUL_API_KEY: z.string().optional(),

  ANSWER_MODEL: z.string().default('claude-sonnet-4-6'),
  // Cheap model for distilling the per-trader learning profile (background,
  // small, throttled). Haiku keeps this near-free.
  PROFILE_MODEL: z.string().default('claude-haiku-4-5'),
  EMBEDDING_MODEL: z.string().default('voyage-3-lite'),

    SEMANTIC_CACHE_SIMILARITY: z.coerce.number().min(0).max(1).default(0.92),
    SEMANTIC_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),

    // ---- Private-beta guardrails (all optional; layer is inert unless BETA_MODE=true) ----
    BETA_MODE: z.coerce.boolean().default(false),
    // ISO timestamp; after it Pip stops serving and posts a wrap-up. Optional.
    BETA_ENDS_AT: z.string().optional(),
    // Discord user id to DM on spend alerts (50/80/100%). Optional.
    FOUNDER_DISCORD_ID: z.string().optional(),
    // Comma-separated allowlists. Empty = allow all servers / all channels.
    BETA_ALLOWED_GUILDS: z.string().optional(),
    BETA_ALLOWED_CHANNELS: z.string().optional(),
    // Daily global kill-switch (USD spend + message count) and per-user caps.
    // Defaults match the beta plan; override per environment if needed.
    BETA_DAILY_SPEND_USD: z.coerce.number().positive().default(18),
    BETA_DAILY_GLOBAL_MSGS: z.coerce.number().int().positive().default(350),
    BETA_USER_DAILY_MSGS: z.coerce.number().int().positive().default(25),
  })
  .superRefine((cfg, ctx) => {
    // A lone Discord token or app id means the adapter can't start — flag it
    // rather than silently skipping Discord.
    const hasToken = Boolean(cfg.DISCORD_TOKEN);
    const hasAppId = Boolean(cfg.DISCORD_APP_ID);
    if (hasToken !== hasAppId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DISCORD_TOKEN and DISCORD_APP_ID must be set together (or both left empty).',
        path: [hasToken ? 'DISCORD_APP_ID' : 'DISCORD_TOKEN'],
      });
    }
    if (!hasToken && !cfg.TELEGRAM_BOT_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'No chat platform configured — set Discord (DISCORD_TOKEN + DISCORD_APP_ID) or TELEGRAM_BOT_TOKEN.',
        path: ['TELEGRAM_BOT_TOKEN'],
      });
    }
  });

export type Config = z.infer<typeof Schema>;

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Config error:\n${issues}\n\nCopy .env.example to .env and fill the required values.`);
  }
  cached = parsed.data;
  return cached;
}

/** Discord adapter loads only when both token slots are present. */
export function discordEnabled(cfg: Config = getConfig()): boolean {
  return Boolean(cfg.DISCORD_TOKEN && cfg.DISCORD_APP_ID);
}

/** Telegram adapter loads only when a bot token is present. */
export function telegramEnabled(cfg: Config = getConfig()): boolean {
  return Boolean(cfg.TELEGRAM_BOT_TOKEN);
}

/** Returns whichever service-role-equivalent key is configured (modern first, then legacy). */
export function supabaseAdminKey(cfg: Config = getConfig()): string | undefined {
  return cfg.SUPABASE_SECRET_KEY || cfg.SUPABASE_SERVICE_ROLE_KEY;
}

/** Memory = per-guild Q&A persistence + recall. Needs Supabase only. */
export function memoryEnabled(cfg: Config = getConfig()): boolean {
  return Boolean(cfg.SUPABASE_URL && supabaseAdminKey(cfg));
}

/** Embeddings = semantic cache + (future) fuzzy recall. Needs Voyage. */
export function embeddingsEnabled(cfg: Config = getConfig()): boolean {
  return Boolean(cfg.VOYAGE_API_KEY);
}

/** FRED macro tool needs a (free) API key. Registered only when set. */
export function fredEnabled(cfg: Config = getConfig()): boolean {
  return Boolean(cfg.FRED_API_KEY);
}

/** AI Wealth Manager companion API. Tools + backdrop load only when its key is set. */
export function companionApiEnabled(cfg: Config = getConfig()): boolean {
  return Boolean(cfg.PAUL_API_KEY);
}

/** Solana Tracker smart-money enrichment for token_scan. Needs a (free) key. */
export function solanaTrackerEnabled(cfg: Config = getConfig()): boolean {
  return Boolean(cfg.SOLANA_TRACKER_API_KEY);
}

/** Finnhub equity tools (snapshot / fundamentals / earnings). Needs a (free) key. */
export function finnhubEnabled(cfg: Config = getConfig()): boolean {
  return Boolean(cfg.FINNHUB_API_KEY);
}

/** FMP full financial statements tool. Needs a (free) key. */
export function fmpEnabled(cfg: Config = getConfig()): boolean {
  return Boolean(cfg.FMP_API_KEY);
}

/** Private-beta guardrails (allowlist, caps, kill-switch). Inert unless set. */
export function betaModeEnabled(cfg: Config = getConfig()): boolean {
  return cfg.BETA_MODE;
}

/** Parse a comma-separated env list into a trimmed Set (empty = no restriction). */
export function csvSet(v: string | undefined): Set<string> {
  return new Set((v ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}
