import { NormalizedReply, NormalizedAttachment, ReplyField, SourceCitation } from '../adapters/platform.js';
import { fmtUtcHm } from './util.js';

const DEFAULT_DISCLAIMER = 'Not financial advice.';

export function buildReply(opts: {
  body: string;
  sources?: SourceCitation[];
  title?: string;
  asOf?: Date;
  disclaimer?: string;
  attachments?: NormalizedAttachment[];
}): NormalizedReply {
  return {
    title: opts.title,
    body: deTable(statsToSnapshot(opts.body)),
    sources: opts.sources ?? [],
    asOf: opts.asOf ?? new Date(),
    disclaimer: opts.disclaimer ?? DEFAULT_DISCLAIMER,
    attachments: opts.attachments?.length ? opts.attachments : undefined,
  };
}

// Matches a `[[STATS]] ... [[/STATS]]` block anywhere in the answer — the
// prompt asks the model to put it first, but the parser doesn't require that
// (a semantic-cache hit appends a suffix after the cached text, for example).
const STATS_RE = /\[\[STATS\]\]\s*\n([\s\S]*?)\n?\s*\[\[\/STATS\]\]\n?/;

/**
 * Answers now render as one sectioned text block (📊 Snapshot / 🧠 Read / …)
 * on both platforms. Older answers — semantic/exact-cache hits and model
 * slips — may still carry a legacy `[[STATS]]` block; convert it in place to
 * a 📊 Snapshot section so it renders in the same visual system.
 */
export function statsToSnapshot(body: string): string {
  const m = STATS_RE.exec(body);
  if (!m) return body;
  const lines = m[1]!
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes(':'));
  const section = lines.length ? `📊 **Snapshot**\n${lines.join('\n')}\n\n` : '';
  return (body.slice(0, m.index) + section + body.slice(m.index + m[0].length)).replace(/^\s+/, '');
}

/**
 * Legacy parser for the `[[STATS]]` block — no longer feeds Discord embed
 * fields (replies are a single sectioned text block now), but memory recall
 * still uses it to flatten stored answers that predate the sectioned layout.
 */
export function extractStats(body: string): { fields: ReplyField[]; body: string } {
  const m = STATS_RE.exec(body);
  if (!m) return { fields: [], body };
  const fields: ReplyField[] = [];
  for (const line of m[1]!.split('\n')) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const name = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (!name || !value) continue;
    fields.push({ name: name.slice(0, 256), value: value.slice(0, 1024) });
    if (fields.length >= 6) break;
  }
  const rest = (body.slice(0, m.index) + body.slice(m.index + m[0].length)).replace(/^\s+/, '');
  return { fields, body: rest };
}

/**
 * Discord does NOT render markdown tables — they show up as raw `| a | b |`
 * pipes (looks broken). The prompt tells Pip not to use them, but models slip,
 * so we convert any table into bullet lines as a safety net.
 *
 * A row like `| Funding positive | Longs paying shorts |` becomes
 * `• **Funding positive** — Longs paying shorts`.
 */
export function deTable(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const isSeparator = (l: string) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(l) && l.includes('-');

  const cells = (l: string) =>
    l
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!isTableRow(line)) {
      out.push(line);
      continue;
    }
    // Gather the contiguous table block.
    const block: string[] = [];
    while (i < lines.length && isTableRow(lines[i]!)) block.push(lines[i++]!);
    i--; // step back; outer loop will advance

    const rows = block.filter((r) => !isSeparator(r));
    for (const r of rows) {
      const c = cells(r).filter((x) => x.length > 0);
      if (c.length === 0) continue;
      const [first, ...rest] = c;
      out.push(rest.length ? `• **${first}** — ${rest.join(' — ')}` : `• ${first}`);
    }
  }
  return out.join('\n');
}

/** Plain-text rendering used when an embed isn't viable (Telegram). */
export function renderReplyText(reply: NormalizedReply): string {
  // Sources intentionally omitted — Pip answers as its own brain (still
  // persisted internally for debugging). Keep only the disclaimer + timestamp.
  // The body already carries the full sectioned layout (📊 Snapshot / 🧠 Read
  // / …) — identical on both platforms by design.
  const parts = [reply.body.trim()];
  parts.push(`\n_${reply.disclaimer ?? DEFAULT_DISCLAIMER} Data as of ${fmtUtcHm(reply.asOf)}._`);
  return parts.join('\n');
}
