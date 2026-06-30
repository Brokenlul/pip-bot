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
    body: opts.body,
    sources: opts.sources ?? [],
    asOf: opts.asOf ?? new Date(),
    disclaimer: opts.disclaimer ?? DEFAULT_DISCLAIMER,
  };
}

/** Plain-text rendering used when an embed isn't viable. */
export function renderReplyText(reply: NormalizedReply): string {
  const parts = [reply.body.trim()];
  if (reply.sources.length > 0) {
    const list = reply.sources
      .map((s) => (s.url ? `[${s.label}](${s.url})` : s.label))
      .join(' · ');
    parts.push(`\nSources: ${list}`);
  }
  parts.push(`\n_${reply.disclaimer ?? DEFAULT_DISCLAIMER} Data as of ${fmtUtcHm(reply.asOf)}._`);
  return parts.join('\n');
}
