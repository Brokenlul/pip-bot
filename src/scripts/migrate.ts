import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig, memoryEnabled } from '../config.js';

/**
 * Tiny migration runner — applies every .sql file under db/migrations
 * in lexical order via Supabase's pg-meta REST endpoint.
 *
 * Each migration must be idempotent (use IF NOT EXISTS / CREATE OR REPLACE).
 * Tracks nothing; safe to re-run.
 *
 * Requires the SERVICE ROLE key. Run:
 *   npm run migrate
 */
async function main() {
  if (!memoryEnabled()) {
    throw new Error(
      'Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and VOYAGE_API_KEY before running migrations.',
    );
  }
  const cfg = getConfig();
  const dir = join(process.cwd(), 'db', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.log('No migrations found.');
    return;
  }
  for (const f of files) {
    const sql = await readFile(join(dir, f), 'utf8');
    console.log(`Applying ${f}…`);
    const res = await fetch(`${cfg.SUPABASE_URL}/pg/v1/query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: cfg.SUPABASE_SERVICE_ROLE_KEY!,
        authorization: `Bearer ${cfg.SUPABASE_SERVICE_ROLE_KEY!}`,
      },
      body: JSON.stringify({ query: sql }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Migration ${f} failed (${res.status}): ${body.slice(0, 500)}\n\n` +
          `If your Supabase project doesn't expose /pg/v1/query, paste db/migrations/${f} into the SQL editor instead.`,
      );
    }
    console.log(`  ✓ ${f}`);
  }
  console.log('All migrations applied.');
}

main().catch((e) => {
  console.error('migrate failed:', e);
  console.error(
    "\nFallback: open Supabase SQL Editor and paste the contents of db/migrations/*.sql in order.",
  );
  process.exit(1);
});
