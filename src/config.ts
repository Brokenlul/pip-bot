import 'dotenv/config';
import { z } from 'zod';

const Schema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required'),
  DISCORD_APP_ID: z.string().min(1, 'DISCORD_APP_ID is required'),
  DISCORD_DEV_GUILD_ID: z.string().optional(),

  SUPABASE_URL: z.string().url().optional(),
  // Two slots, both bypass RLS. Code picks whichever is set (SECRET_KEY first).
  SUPABASE_SECRET_KEY: z.string().optional(),        // modern: sb_secret_...
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),  // legacy JWT: eyJ...

  COINGECKO_API_KEY: z.string().optional(),
  VOYAGE_API_KEY: z.string().optional(),

  ANSWER_MODEL: z.string().default('claude-sonnet-4-6'),
  EMBEDDING_MODEL: z.string().default('voyage-3-lite'),

  SEMANTIC_CACHE_SIMILARITY: z.coerce.number().min(0).max(1).default(0.92),
  SEMANTIC_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
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
