/**
 * News-wire health check.
 *
 * Run: npm run check-wires
 *
 * Why this exists: on 2026-07-27 Pip missed the Iran ceasefire even though it
 * called news_wire on the message. The tool was fine — its two sources weren't.
 * BWEnews had quietly become a pure exchange-listings bot, and infinityhedge
 * had not posted in five days. Neither failed; both returned HTTP 200. A wire
 * that goes quiet is invisible until a user pastes you news you should have had.
 *
 * This prints each channel's post volume, the age of its newest post, and a
 * sample headline, so a dead or drifting source is obvious in one glance
 * instead of after a bad answer. STALE/EMPTY exits non-zero so it can be wired
 * to a scheduled check later.
 */
import { newsWireTool, NEWS_WIRE_SLUGS } from '../data/news-wire.js';

// A wire quieter than this has either died or stopped covering what we added it
// for. Deliberately generous — some of these are genuinely low-volume.
const STALE_HOURS = 48;

interface Row {
  slug: string;
  posts: number;
  newestAgeH: number | null;
  spanH: number;
  sample: string;
}

async function main(): Promise<void> {
  // The tool's own channel list, so this can never drift from what Pip reads.
  const slugs = NEWS_WIRE_SLUGS;

  const rows: Row[] = [];
  const failed: string[] = [];

  for (const slug of slugs) {
    try {
      const out = await newsWireTool.execute({ channel: slug, limit: 30 } as never, {} as never);
      const times = out.items.map((i) => new Date(i.published_at).getTime()).sort((a, b) => a - b);
      const newest = times[times.length - 1];
      rows.push({
        slug,
        posts: out.items.length,
        newestAgeH: newest ? (Date.now() - newest) / 3_600_000 : null,
        spanH: times.length > 1 ? (newest! - times[0]!) / 3_600_000 : 0,
        sample: (out.items[0]?.text ?? '').replace(/\s+/g, ' ').slice(0, 80),
      });
    } catch (e) {
      failed.push(`${slug}: ${(e as Error).message}`);
    }
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(pad('CHANNEL', 18) + pad('POSTS', 7) + pad('NEWEST', 12) + pad('PER DAY', 9) + 'STATUS');
  for (const r of rows) {
    const perDay = r.spanH > 0 ? (r.posts / (r.spanH / 24)).toFixed(1) : '—';
    const age = r.newestAgeH === null ? '—' : `${r.newestAgeH.toFixed(1)}h`;
    const status = r.newestAgeH !== null && r.newestAgeH > STALE_HOURS ? `STALE (>${STALE_HOURS}h)` : 'ok';
    console.log(pad(r.slug, 18) + pad(String(r.posts), 7) + pad(age, 12) + pad(perDay, 9) + status);
    console.log(`  └ ${r.sample}`);
  }
  for (const f of failed) console.log(`UNAVAILABLE  ${f}`);

  const stale = rows.filter((r) => r.newestAgeH !== null && r.newestAgeH > STALE_HOURS);
  if (stale.length || failed.length) {
    console.log(
      `\n${stale.length} stale, ${failed.length} unavailable. ` +
        'A quiet wire is not the same as a quiet market — replace or remove it.',
    );
    process.exit(1);
  }
  console.log(`\nAll ${rows.length} wires healthy.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
