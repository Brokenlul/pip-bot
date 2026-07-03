// Local preview for the Pip dashboard — no Vercel account needed.
//   cd pip-dashboard && node dev-server.mjs   →   http://localhost:3000
// Loads Supabase creds from the bot's ../.env, then serves the same function
// Vercel would run in production.
import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// Pull env from the bot's .env (SUPABASE_URL / SUPABASE_SECRET_KEY / BETA caps).
try {
  const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
} catch {
  console.warn('No ../.env found — set SUPABASE_URL and SUPABASE_SECRET_KEY in the environment.');
}

const require = createRequire(import.meta.url);
const handler = require('./api/index.js');
const port = Number(process.env.PORT || 3000);

http
  .createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    req.query = Object.fromEntries(u.searchParams);
    Promise.resolve(handler(req, res)).catch((e) => {
      res.statusCode = 500;
      res.end('Error: ' + (e?.message || e));
    });
  })
  .listen(port, () => console.log(`Pip dashboard preview → http://localhost:${port}`));
