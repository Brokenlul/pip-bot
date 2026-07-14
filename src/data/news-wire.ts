import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';

/**
 * Curated fast-news wires — public Telegram channels known for posting
 * breaking crypto/macro headlines (exchange listings, data prints, Fed
 * statements) faster than mainstream press. Read via the keyless `t.me/s/...`
 * preview (no bot token / channel membership needed).
 * User-picked sources (2026-07-14): BWEnews, infinityhedge.
 */

const CHANNELS: Record<string, string> = {
  bwenews: 'BWEnews',
  infinityhedge: 'infinityhedge',
};

const InputSchema = z.object({
  channel: z.enum(['bwenews', 'infinityhedge', 'all']).optional().describe('Which wire to read, or "all" for both merged by recency (default).'),
  limit: z.number().int().min(1).max(20).optional().describe('Max posts to return (default 8, max 20).'),
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
  source_url: string;
}

const cache = makeCache<NewsItem[]>(60_000); // 60s — these wires post continuously

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function fetchChannel(slug: string): Promise<NewsItem[]> {
  const handle = CHANNELS[slug];
  if (!handle) throw new Error(`Unknown news channel: ${slug}`);
  return cache.wrap(slug, async () => {
    return withRetry(async () => {
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
  });
}

export const newsWireTool: Tool<Input, Output> = {
  name: 'news_wire',
  description:
    'Breaking crypto/macro headlines from curated fast-news wires (BWEnews, infinityhedge) — exchange listings, data-print releases (CPI/NFP/Fed), and geopolitical headlines, often minutes ahead of mainstream press. Use when the user asks for the latest news/headlines, references a specific breaking event, or when a scheduled macro print may have JUST dropped and official sources (FRED) have not ingested it yet — this wire often has the number first.',
  inputSchema: {
    type: 'object',
    properties: {
      channel: { type: 'string', enum: ['bwenews', 'infinityhedge', 'all'], description: 'Which wire to read, or "all" for both merged (default).' },
      limit: { type: 'number', description: 'Max posts to return (default 8, max 20).' },
    },
    required: [],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    const channel = input.channel ?? 'all';
    const limit = input.limit ?? 8;
    const slugs = channel === 'all' ? (['bwenews', 'infinityhedge'] as const) : ([channel] as const);
    const lists = await Promise.all(slugs.map(fetchChannel));
    const merged = lists
      .flat()
      .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())
      .slice(0, limit);
    return { items: merged, source_url: 'https://t.me/s/BWEnews' };
  },
  citation: (input, out) => ({
    label: input.channel && input.channel !== 'all' ? `News wire (${CHANNELS[input.channel]})` : 'News wire (BWEnews, infinityhedge)',
    url: out.items[0]?.url ?? out.source_url,
  }),
};
