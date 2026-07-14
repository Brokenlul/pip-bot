import { z } from 'zod';
import { Tool, zValidator } from './registry.js';
import { makeCache, withRetry, fetchWithTimeout } from '../core/util.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Fetch the full, verbatim text of an official central-bank / treasury
 * statement — the "primary source over paraphrase" pattern, applied
 * consistently across every major source Pip's macro reads lean on. Each of
 * these publishes same-day, no auth/API key. Pairs with web_search: search
 * finds the page, this tool pulls the clean text — HTML via a per-domain
 * body-boundary marker, PDF via pdfjs-dist's real embedded text layer (the
 * Bank of Japan publishes text-layer PDFs, not scanned images — a proper
 * PDF text extraction handles them accurately; OCR would be the wrong tool
 * for a document that already has selectable text).
 */

interface DomainConfig {
  label: string;
  // Literal substring or regex marking where the real article body starts —
  // slicing from here skips nav/menu/share-widget chrome that would otherwise
  // pollute a blanket tag scan (worst case: ECB's multi-thousand-link nav).
  // Irrelevant for domains whose pages are PDF-only (BoJ).
  bodyMarker?: string | RegExp;
}

const DOMAINS: Record<string, DomainConfig> = {
  'federalreserve.gov': {
    label: 'Federal Reserve',
    // The body div is plain `col-xs-12 col-sm-8 col-md-8`, distinct from the
    // `heading col-xs-12 col-sm-8 col-md-8` div that precedes it and contains
    // a malformed, never-closed <p class="releaseTime"> around a share-button
    // widget — starting from the heading would swallow that widget whole.
    bodyMarker: '<div class="col-xs-12 col-sm-8 col-md-8">',
  },
  'home.treasury.gov': {
    label: 'U.S. Treasury',
    bodyMarker: /field--name-field-news-body[^"]*"[^>]*>/,
  },
  'ecb.europa.eu': {
    label: 'European Central Bank',
    bodyMarker: /<main[^>]*>/,
  },
  'bankofengland.co.uk': {
    label: 'Bank of England',
    bodyMarker: 'id="output"',
  },
  'boj.or.jp': {
    label: 'Bank of Japan',
    // 2026 statements are PDF-only — handled by extractPdfText below, no HTML marker needed.
  },
};

function matchDomain(hostname: string): DomainConfig | undefined {
  const h = hostname.toLowerCase();
  for (const [domain, cfg] of Object.entries(DOMAINS)) {
    if (h === domain || h.endsWith(`.${domain}`)) return cfg;
  }
  return undefined;
}

const InputSchema = z.object({
  url: z
    .string()
    .url()
    .describe(
      'A URL on federalreserve.gov, home.treasury.gov, ecb.europa.eu, or bankofengland.co.uk (found via web_search).',
    ),
});
type Input = z.infer<typeof InputSchema>;

interface Output {
  source: string;
  title: string;
  text: string;
  truncated: boolean;
  source_url: string;
}

const MAX_CHARS = 8000;
const cache = makeCache<Output>(30 * 60_000); // 30 min — a published statement never changes

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"')
    .replace(/&ldquo;/g, '"')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Remove whole blocks that are never wanted as text — scripts, styles, and data tables (which render as unreadable garble once tags are stripped). */
function stripBlocks(html: string, tag: string): string {
  return html.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
}

/** Pull paragraph/list-item/heading blocks — covers prose (Fed) and bulleted content (Treasury) alike. */
function extractText(html: string): string {
  let h = stripBlocks(html, 'script');
  h = stripBlocks(h, 'style');
  h = stripBlocks(h, 'table');
  return [...h.matchAll(/<(p|li|h[1-6])(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)]
    .map((m) => decodeEntities(m[2]!.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 15) // drops nav crumbs/labels, not real sentences
    .join('\n\n');
}

/** Extract the real embedded text layer from a PDF (not OCR — these are digitally authored, not scanned). */
async function extractPdfText(buf: ArrayBuffer): Promise<{ title: string | null; text: string }> {
  const doc = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  const meta = await doc.getMetadata().catch(() => null);
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  const title = (meta?.info as { Title?: string } | undefined)?.Title?.trim() || null;
  const text = pages
    .join('\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

export const officialStatementTool: Tool<Input, Output> = {
  name: 'official_statement_text',
  description:
    'Fetch the full, verbatim text of an official central-bank or treasury communication — FOMC statements/minutes, Fed testimony/speeches (federalreserve.gov), U.S. Treasury press releases (home.treasury.gov), ECB monetary policy statements (ecb.europa.eu), Bank of England policy summaries (bankofengland.co.uk), or Bank of Japan policy statements (boj.or.jp, published as PDF — handled automatically). Use this AFTER web_search finds the page to quote the exact official wording instead of paraphrasing secondhand coverage — precise wording changes between meetings ARE the signal. This is the consistent, standard way to ground any major policy event across all five. Does NOT cover live/extemporaneous Q&A during a hearing or press conference — use news_wire/web_search for that.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Page or PDF URL on federalreserve.gov, home.treasury.gov, ecb.europa.eu, bankofengland.co.uk, or boj.or.jp.',
      },
    },
    required: ['url'],
  },
  validate: zValidator(InputSchema),
  execute: async (input) => {
    const u = new URL(input.url);
    const domain = matchDomain(u.hostname);
    if (!domain) {
      throw new Error(
        `official_statement_text only covers federalreserve.gov, home.treasury.gov, ecb.europa.eu, bankofengland.co.uk, and boj.or.jp.`,
      );
    }
    return cache.wrap(input.url, async () => {
      return withRetry(async () => {
        const res = await fetchWithTimeout(
          input.url,
          { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PipBot/1.0)' } },
          15_000, // gov sites (esp. treasury.gov) can be slow/large — the 8s default is too tight
        );
        if (!res.ok) throw new Error(`official_statement_text ${res.status}`);

        const isPdf =
          u.pathname.toLowerCase().endsWith('.pdf') ||
          (res.headers.get('content-type') ?? '').includes('application/pdf');

        let title: string;
        let full: string;
        if (isPdf) {
          const parsed = await extractPdfText(await res.arrayBuffer());
          title = parsed.title ?? domain.label;
          full = parsed.text;
        } else {
          const html = await res.text();
          title = decodeEntities(html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim() ?? domain.label);
          let bodyStart = -1;
          if (typeof domain.bodyMarker === 'string') {
            const idx = html.indexOf(domain.bodyMarker);
            if (idx !== -1) bodyStart = idx + domain.bodyMarker.length;
          } else if (domain.bodyMarker) {
            const m = html.match(domain.bodyMarker);
            if (m && m.index !== undefined) bodyStart = m.index + m[0].length;
          }
          const scoped = bodyStart === -1 ? html : html.slice(bodyStart);
          full = extractText(scoped);
        }

        if (!full) throw new Error('No article text found at that URL — is it the right link?');
        const truncated = full.length > MAX_CHARS;
        return {
          source: domain.label,
          title,
          text: truncated ? `${full.slice(0, MAX_CHARS)}…` : full,
          truncated,
          source_url: input.url,
        };
      }, `official-statement:${input.url}`);
    });
  },
  citation: (input, out) => ({ label: `${out.source} (${out.title})`, url: input.url }),
};
