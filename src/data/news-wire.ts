import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';

/**
 * Curated fast-news wires — public Telegram channels that post breaking
 * crypto/macro headlines faster than mainstream press. Read via the keyless
 * `t.me/s/...` preview: no bot token, no channel membership, no admin rights.
 *
 * Sources revised 2026-07-27 after Pip missed the Iran ceasefire. The plumbing
 * was never the problem — usage_log shows Pip DID call this tool on that
 * message. It was reading two channels that don't cover breaking macro:
 * BWEnews is a listings bot, and infinityhedge had gone 5 days silent.
 * walterbloomberg carried "IRAN PAUSES RETALIATORY STRIKES" at 09:06Z, one
 * hour 58 minutes before the user had to paste it in.
 *
 * Picking sources: check the LATEST post's age and what the recent posts are
 * actually about, not just that the channel exists. A dead wire and a wire full
 * of the wrong category both return HTTP 200.
 */

interface Channel {
  handle: string; // exact t.me handle, case-sensitive in the URL
  label: string; // shown in citations
  covers: string; // what it's actually good for — drives the tool description
}

const CHANNELS: Record<string, Channel> = {
  walterbloomberg: {
    // Telegram mirror of x.com/DeItaone (Walter Bloomberg). Terse all-caps
    // headline wire: geopolitics, central banks, earnings crosses, macro prints.
    // Chosen over the near-identical @walter_bloomberg mirror, which carries the
    // same posts 3-8 minutes later with a 🚨 prefix.
    handle: 'WalterBloomberg',
    label: 'Walter Bloomberg',
    covers: 'breaking macro, geopolitics, central banks and earnings headlines',
  },
  zoomerfied: {
    handle: 'ZoomerfiedNews',
    label: 'Zoomerfied News',
    covers: 'prediction-market odds, AI/tech and crypto-adjacent headlines',
  },
  infinityhedge: {
    handle: 'infinityhedge',
    label: 'InfinityHedge',
    covers: 'US policy, legislative and earnings headlines (low volume, often quiet for days)',
  },
  bwenews: {
    // Kept, but it is a LISTINGS bot, not a macro wire — nearly every post is a
    // Bithumb/Upbit/Binance listing notice. Labelled honestly so Pip stops
    // treating an absence of macro news here as evidence nothing happened.
    handle: 'BWEnews',
    label: 'BWEnews',
    covers: 'exchange listing and delisting announcements',
  },
};

/** Exported so the health check can never drift from what Pip actually reads. */
export const NEWS_WIRE_SLUGS = Object.keys(CHANNELS) as [string, ...string[]];
const SLUGS = NEWS_WIRE_SLUGS;

const InputSchema = z.object({
  channel: z.enum([...SLUGS, 'all'] as [string, ...string[]]).optional().describe('Which wire to read, or "all" for every wire merged by recency (default).'),
  limit: z.number().int().min(1).max(30).optional().describe('Max posts to return (default 10, max 30).'),
});
type Input = z.infer<typeof InputSchema>;

interface NewsItem {
  channel: string;
  text: string;
  published_at: string;
  url: string;
}
interface Output {
  items: NewsItem[];
  /** Wires that failed this call — surfaced so a partial read isn't read as calm. */
  unavailable?: string[];
  source_url: string;
}

const cache = makeCache<NewsItem[]>(60_000); // 60s — these wires post continuously

function decodeEntities(s: string): string {
  return (
    s
      // Numeric entities first, and generically: these wires escape '$' as
      // `&#036;`, so a named-entity-only decoder left every dollar figure in an
      // earnings headline as "ALPHABET 2Q REV. EX-TAC &#036;103.62B". Pip reads
      // this text verbatim, so a mangled number is a wrong number.
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ')
      // &amp; last, so "&amp;lt;" doesn't become a real '<'.
      .replace(/&amp;/g, '&')
  );
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchChannel(slug: string): Promise<NewsItem[]> {
  const handle = CHANNELS[slug]?.handle;
  if (!handle) throw new Error(`Unknown news channel: ${slug}`);
  return cache.wrap(slug, async () => {
    const items = await withRetry(async () => {
      const res = await fetchWithTimeout(`https://t.me/s/${handle}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PipBot/1.0)' },
      });
      if (!res.ok) throw new Error(`telegram preview ${handle} ${res.status}`);
      const html = await res.text();
      const chunks = html.split('<div class="tgme_widget_message_wrap js-widget_message_wrap">').slice(1);
      const items: NewsItem[] = [];
      for (const chunk of chunks) {
        const post = chunk.match(/data-post="([^"]+)"/)?.[1];
        const textHtml = chunk.match(/tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/)?.[1];
        const when = chunk.match(/<time datetime="([^"]+)"/)?.[1];
        if (!post || !textHtml || !when) continue;
        const text = stripTags(textHtml);
        if (!text) continue;
        items.push({ channel: handle, text, published_at: new Date(when).toISOString(), url: `https://t.me/${post}` });
      }
      return items; // oldest → newest, as the page lists them
    }, `news-wire:${slug}`);

    // t.me/s/ answers 200 with an empty page for a channel that was renamed,
    // deleted, or had its public preview switched off — verified against a
    // made-up handle and against @Deltaone, both 200 with zero posts. Left as
    // an empty list that is indistinguishable from "nothing is happening",
    // which is the silent coverage hole that produced the wrong gold price. A
    // live wire is never empty, so treat this as the source being gone.
    // Outside withRetry deliberately: retrying a renamed channel cannot help.
    if (!items.length) {
      throw new Error(`${handle}: preview returned no posts (renamed, deleted, or preview disabled?)`);
    }
    return items;
  });
}

export const newsWireTool: Tool<Input, Output> = {
  name: 'news_wire',
  description:
    'Breaking crypto/macro headlines from curated fast Telegram news wires — geopolitics, central-bank and policy headlines, earnings crosses, data-print releases (CPI/NFP/Fed) and exchange listings, often minutes to hours ahead of mainstream press. Use when the user asks for the latest news/headlines, references a specific breaking event, or when a scheduled macro print may have JUST dropped and official sources (FRED) have not ingested it yet — this wire often has the number first. Default "all" merges every wire by recency; only narrow to one channel when the user asks about that specific source.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', enum: [...SLUGS, 'all'], description: 'Which wire to read, or "all" for every wire merged by recency (default).' },
      limit: { type: 'number', description: 'Max posts to return (default 10, max 30).' },
    },
    required: [],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    const channel = input.channel ?? 'all';
    const limit = input.limit ?? 10;
    const slugs = channel === 'all' ? SLUGS : [channel];

    // allSettled, NOT all: one dead or renamed channel must not take the whole
    // wire down with it. Returning nothing would read to Pip as "no news", which
    // is the same silent-coverage-hole failure that produced the wrong gold
    // price — an absent feed has to look absent, not calm.
    const settled = await Promise.allSettled(slugs.map(fetchChannel));
    const items: NewsItem[] = [];
    const unavailable: string[] = [];
    settled.forEach((r, i) => {
      const slug = slugs[i]!;
      if (r.status === 'fulfilled') items.push(...r.value);
      else {
        unavailable.push(CHANNELS[slug]!.label);
        console.warn(`[news-wire] ${slug} unavailable: ${r.reason?.message ?? r.reason}`);
      }
    });
    if (!items.length && unavailable.length) {
      throw new Error(`news wires unavailable: ${unavailable.join(', ')}`);
    }

    const merged = items
      .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())
      .slice(0, limit);
    return {
      items: merged,
      ...(unavailable.length ? { unavailable } : {}),
      source_url: `https://t.me/s/${CHANNELS.walterbloomberg!.handle}`,
    };
  },
  citation: (input, out) => ({
    label:
      input.channel && input.channel !== 'all'
        ? `News wire (${CHANNELS[input.channel]?.label ?? input.channel})`
        : 'News wire',
    url: out.items[0]?.url ?? out.source_url,
  }),
};
