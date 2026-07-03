import Anthropic from '@anthropic-ai/sdk';
import { getConfig, memoryEnabled } from '../config.js';
import { getDb } from './db.js';

/**
 * Per-trader learning layer. Pip builds a compact, evolving profile of each user
 * from their OWN conversation history and 👍/👎 reactions, and injects it into
 * the prompt so answers get more tailored the more someone uses it. The profile
 * is distilled by a cheap model (Haiku), throttled so it costs almost nothing.
 *
 * Privacy: read and written per (guild_id, user_id); only ever used to serve
 * that same trader.
 */

const REFRESH_MS = 15 * 60 * 1000; // at most one distill per user per 15 min
const HISTORY_TURNS = 12;
const MIN_TURNS = 2; // not enough to learn anything below this
const MAX_PROFILE_CHARS = 1200;

let client: Anthropic | null = null;
function anth(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: getConfig().ANTHROPIC_API_KEY, timeout: 20_000, maxRetries: 1 });
  return client;
}

/** The living profile for this trader, or null if none yet. Fast PK read. */
export async function getProfile(guildId: string, userId: string): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  const { data } = await db
    .from('user_profiles')
    .select('profile')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .limit(1);
  const p = data?.[0]?.profile as string | undefined;
  return p && p.trim() ? p : null;
}

const DISTILL_SYSTEM = `You maintain a concise, living profile of ONE trader. An AI market analyst named Pip uses it to tailor its answers to this person over time.

From their recent questions, Pip's answers, and their 👍/👎 reactions (correlate each reaction to the answer it most likely followed, by timestamp), update the profile to capture ONLY what the evidence supports:
1. Assets / markets they focus on (tickers, chains, sectors).
2. Trading style and typical timeframe (scalp / intraday / swing / investor).
3. Experience level and risk posture.
4. How they prefer answers — length, depth, tone, what format lands.
5. What to lean into, and what to AVOID (infer from 👎'd answers — e.g. too long, hedged too much, drifted off their asset).

Rules: under 110 words. Specific and evidence-based — drop anything not clearly supported. Evolve the existing profile, don't restate it wholesale. Output ONLY the profile prose, no preamble, no headers.`;

const trunc = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * Distill/refresh the trader's profile. Throttled (skips if refreshed recently)
 * and gated on having enough history. Runs on a cheap model in the background —
 * fire-and-forget; never blocks or breaks a reply.
 */
export async function refreshProfile(guildId: string, userId: string): Promise<void> {
  const db = getDb();
  if (!db || !memoryEnabled()) return;

  const { data: existing } = await db
    .from('user_profiles')
    .select('profile, updated_at')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .limit(1);
  const prev = existing?.[0];
  if (prev && Date.now() - new Date(prev.updated_at).getTime() < REFRESH_MS) return; // throttle

  const { data: convs } = await db
    .from('conversations')
    .select('question, answer, created_at')
    .eq('guild_id', guildId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_TURNS);
  if (!convs || convs.length < MIN_TURNS) return;

  const { data: fb } = await db
    .from('feedback')
    .select('rating, created_at')
    .eq('guild_id', guildId)
    .eq('rater_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  const history = [...convs]
    .reverse()
    .map((c) => `Q (${c.created_at.slice(0, 16)}): ${trunc(c.question, 200)}\nA: ${trunc(c.answer, 400)}`)
    .join('\n\n');
  const reactions =
    (fb ?? []).map((f) => `${f.rating === 'up' ? '👍' : '👎'} @ ${f.created_at.slice(0, 16)}`).join(', ') ||
    'none yet';

  const userMsg =
    `Existing profile:\n${prev?.profile?.trim() || '(none yet)'}\n\n` +
    `Recent exchanges (oldest→newest):\n${history}\n\n` +
    `Their reactions (correlate to the answers above by time): ${reactions}\n\n` +
    `Write the updated profile.`;

  let text = '';
  try {
    const resp = await anth().messages.create({
      model: getConfig().PROFILE_MODEL,
      max_tokens: 300,
      system: DISTILL_SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    });
    text = resp.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  } catch (e) {
    console.warn(`[learn] distill failed: ${(e as Error).message}`);
    return;
  }
  if (!text) return;

  await db
    .from('user_profiles')
    .upsert(
      { guild_id: guildId, user_id: userId, profile: trunc(text, MAX_PROFILE_CHARS), updated_at: new Date().toISOString() },
      { onConflict: 'guild_id,user_id' },
    )
    .throwOnError();
}
