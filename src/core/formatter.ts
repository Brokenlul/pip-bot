import { NormalizedReply, SourceCitation } from '../adapters/platform.js';
import { fmtUtcHm } from './util.js';

const DEFAULT_DISCLAIMER = 'Not financial advice.';

export function buildReply(opts: {
  body: string;
  sources?: SourceCitation[];
  title?: string;
  asOf?: Date;
  disclaimer?: string;
}): NormalizedReply {
  return {
    title: opts.title,
    body: deTable(opts.body),
    sources: opts.sources ?? [],
    asOf: opts.asOf ?? new Date(),
    disclaimer: opts.disclaimer ?? DEFAULT_DISCLAIMER,
  };
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

/** Plain-text rendering used when an embed isn't viable. */
export function renderReplyText(reply: NormalizedReply): string {
  // Sources intentionally omitted — Pip answers as its own brain (still
  // persisted internally for debugging). Keep only the disclaimer + timestamp.
  const parts = [reply.body.trim()];
  parts.push(`\n_${reply.disclaimer ?? DEFAULT_DISCLAIMER} Data as of ${fmtUtcHm(reply.asOf)}._`);
  return parts.join('\n');
}
