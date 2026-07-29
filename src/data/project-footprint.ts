import { lookup } from 'node:dns/promises';
import { fetchWithTimeout } from '../core/util.js';

/**
 * Project footprint — the OFF-CHAIN half of a token read.
 *
 * Why this exists (2026-07-29): a user asked "what is stonkbroker / what does
 * it do". token_scan handed back market data plus the token's own website and
 * X links, and Pip answered "pure memecoin, no product, no roadmap, no team
 * delivering anything". The website's own metadata said the opposite: a DeFi
 * suite (NFT AMM, launcher, vDEX + options) on Robinhood Chain with DATED
 * roadmap milestones, a named publisher (Clutch Markets) and a GitHub org that
 * really does host a perps repo. The URLs were already in the scan output and
 * nothing ever opened them, so absence of a security feed got reported as
 * absence of a product.
 *
 * So: fetch what the project says about itself, and verify the part that is
 * cheaply verifiable (does the GitHub actually exist and has anyone pushed to
 * it). This never decides whether a project is GOOD — it decides whether Pip
 * is allowed to say "it's just a meme". A `checked:false` result means we did
 * not look, which is NOT the same as "there is nothing there"; the two must
 * stay distinguishable all the way into the prompt.
 *
 * Everything here is keyless and best-effort. A dead site is a real signal
 * (reachable:false), not an error worth failing a scan over.
 */

// These URLs come from DexScreener token metadata, i.e. from whoever listed
// the token — treat them as hostile input. A scammer can point "website" at
// a cloud metadata endpoint or an internal address, so every hop is resolved
// and checked before we fetch it (SSRF).
const PRIVATE_V4 =
  /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

function isPrivateAddr(ip: string, family: number): boolean {
  if (family === 4) return PRIVATE_V4.test(ip);
  const v6 = ip.toLowerCase();
  // loopback, link-local, unique-local, and v4-mapped forms.
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fe80:') || v6.startsWith('fc') || v6.startsWith('fd')) return true;
  const mapped = v6.replace(/^::ffff:/, '');
  return mapped !== v6 && PRIVATE_V4.test(mapped);
}

/** http(s) only, public host only. Returns null when the URL must not be fetched. */
async function safeUrl(raw: string): Promise<URL | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return null;
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.length === 0) return null;
    if (addrs.some((a) => isPrivateAddr(a.address, a.family))) return null;
  } catch {
    return null; // unresolvable host — nothing to fetch
  }
  return u;
}

const MAX_REDIRECTS = 3;
const MAX_BYTES = 400_000; // plenty for <head>; stops a multi-MB page from eating memory
const UA = 'Mozilla/5.0 (compatible; PipBot/1.0; +https://pipinvest.xyz)';
// Hard wall-clock budget for the whole footprint read. Redirect hops are
// sequential, so a per-hop timeout alone lets a slow chain stack up into a
// reply-killing delay; this bounds the lot. A scan that answers late is a
// scan the trader already gave up on.
const TOTAL_BUDGET_MS = 12_000;
const HOP_TIMEOUT_MS = 6_000;

/** Remaining budget, or 0 once spent. */
function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

interface FetchedPage {
  finalUrl: string;
  status: number;
  html: string;
}

/**
 * Fetch a page, following redirects MANUALLY so each hop is SSRF-checked —
 * `redirect: 'follow'` would happily land on an internal address after an
 * innocent-looking first hop. Body is truncated at MAX_BYTES.
 */
async function fetchPage(raw: string, deadline: number): Promise<FetchedPage | null> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const left = remaining(deadline);
    if (left <= 0) return null;
    const safe = await safeUrl(current);
    if (!safe) return null;
    const res = await fetchWithTimeout(
      safe.toString(),
      { redirect: 'manual', headers: { 'user-agent': UA, accept: 'text/html,*/*' } },
      Math.min(HOP_TIMEOUT_MS, left),
    );
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { finalUrl: safe.toString(), status: res.status, html: '' };
      current = new URL(loc, safe).toString();
      continue;
    }
    const ctype = res.headers.get('content-type') ?? '';
    if (!res.ok || !/html|text|json/i.test(ctype)) {
      return { finalUrl: safe.toString(), status: res.status, html: '' };
    }
    return { finalUrl: safe.toString(), status: res.status, html: await readCapped(res) };
  }
  return null; // redirect loop
}

/** Read a response body but stop at MAX_BYTES rather than buffering the whole thing. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, MAX_BYTES);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

// ---- HTML / JSON-LD extraction -------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#38);/g, '&')
    .replace(/&(?:lt|#60);/g, '<')
    .replace(/&(?:gt|#62);/g, '>')
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&(?:nbsp|#160);/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

function clean(s: string | null | undefined, max = 400): string | null {
  if (!s) return null;
  const t = decodeEntities(s).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

/** Value of <meta name|property="…" content="…"> regardless of attribute order. */
function meta(html: string, key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${k}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${k}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return m[1];
  }
  return null;
}

interface JsonLd {
  '@type'?: string | string[];
  name?: string;
  description?: string;
  applicationCategory?: string;
  url?: string;
  sameAs?: string[];
  publisher?: { name?: string; url?: string; sameAs?: string[] };
  author?: { name?: string };
}

/** All JSON-LD blocks, flattened (a page may ship an array or @graph). */
function jsonLdBlocks(html: string): JsonLd[] {
  const out: JsonLd[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) != null) {
    try {
      const parsed: unknown = JSON.parse(m[1]!.trim());
      const list = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of list) {
        if (item && typeof item === 'object') {
          const o = item as JsonLd & { '@graph'?: unknown[] };
          if (Array.isArray(o['@graph'])) {
            for (const g of o['@graph']) if (g && typeof g === 'object') out.push(g as JsonLd);
          } else {
            out.push(o);
          }
        }
      }
    } catch {
      // malformed block — skip it, the meta tags still carry signal
    }
  }
  return out;
}

/** Links that indicate an actual product/team, keyed by kind. */
const LINK_KINDS: { kind: keyof FootprintLinks; re: RegExp }[] = [
  { kind: 'github', re: /https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?/i },
  { kind: 'docs', re: /https?:\/\/[^"'\s]*(?:docs\.|\.gitbook\.io|\/docs\/?|\/whitepaper)[^"'\s]*/i },
  { kind: 'discord', re: /https?:\/\/(?:discord\.gg|discord\.com\/invite)\/[A-Za-z0-9]+/i },
  { kind: 'telegram', re: /https?:\/\/t\.me\/[A-Za-z0-9_]+/i },
  { kind: 'twitter', re: /https?:\/\/(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+/i },
];

export interface FootprintLinks {
  github?: string;
  docs?: string;
  discord?: string;
  telegram?: string;
  twitter?: string;
}

function extractLinks(html: string, extra: string[]): FootprintLinks {
  const hay = `${html}\n${extra.join('\n')}`;
  const links: FootprintLinks = {};
  for (const { kind, re } of LINK_KINDS) {
    const m = re.exec(hay);
    if (!m?.[0]) continue;
    const url = m[0].replace(/[),.]+$/, '');
    // Skip URI templates (schema.org SearchAction ships "?q={search_term_string}")
    // — they're markup, not a link a human can open.
    if (url.includes('{')) continue;
    links[kind] = url;
  }
  return links;
}

// ---- GitHub: is anyone actually building ---------------------------------

export interface GithubRead {
  owner: string;
  exists: boolean;
  public_repos: number | null;
  /** Most recently pushed public repo — the real "still building" tell. */
  latest_push: { repo: string; pushed_at: string; language: string | null } | null;
}

interface GhOwner {
  login?: string;
  public_repos?: number;
}
interface GhRepo {
  name?: string;
  pushed_at?: string;
  language?: string | null;
  fork?: boolean;
}

/**
 * Verify a linked GitHub. A 404 here means "not publicly visible" — it could
 * be private or renamed, NOT proof the team lied, and it must never be
 * reported as "the GitHub is fake".
 */
export async function fetchGithub(url: string, deadline = Date.now() + 8000): Promise<GithubRead | null> {
  const m = /github\.com\/([A-Za-z0-9_.-]+)/i.exec(url);
  const owner = m?.[1];
  if (!owner || ['orgs', 'features', 'about', 'pricing'].includes(owner.toLowerCase())) return null;
  if (remaining(deadline) <= 0) return null;

  const headers = { accept: 'application/vnd.github+json', 'user-agent': UA };
  const res = await fetchWithTimeout(
    `https://api.github.com/users/${encodeURIComponent(owner)}`,
    { headers },
    Math.min(6000, remaining(deadline)),
  );
  if (res.status === 404) return { owner, exists: false, public_repos: null, latest_push: null };
  if (!res.ok) return null; // rate-limited / transient — say nothing rather than guess
  const info = (await res.json()) as GhOwner;

  let latest: GithubRead['latest_push'] = null;
  try {
    if (remaining(deadline) <= 0) throw new Error('budget spent');
    const rr = await fetchWithTimeout(
      `https://api.github.com/users/${encodeURIComponent(owner)}/repos?sort=pushed&per_page=5`,
      { headers },
      Math.min(6000, remaining(deadline)),
    );
    if (rr.ok) {
      const repos = (await rr.json()) as GhRepo[];
      const top = repos.filter((r) => !r.fork).find((r) => r.pushed_at);
      if (top?.name && top.pushed_at) {
        latest = { repo: top.name, pushed_at: top.pushed_at, language: top.language ?? null };
      }
    }
  } catch {
    // repo listing is a bonus; the owner check already landed
  }

  return {
    owner,
    exists: true,
    public_repos: typeof info.public_repos === 'number' ? info.public_repos : null,
    latest_push: latest,
  };
}

// ---- Public shape ---------------------------------------------------------

export interface WebsiteRead {
  url: string;
  reachable: boolean;
  status: number | null;
  title: string | null;
  /** meta/og description — the project's own one-liner. */
  description: string | null;
  /** JSON-LD description: usually the richest "what this actually does". */
  claims: string | null;
  category: string | null;
  publisher: string | null;
  links: FootprintLinks;
}

export interface ProjectFootprint {
  /** False = we never looked. NEVER read a false here as "no product exists". */
  checked: boolean;
  website: WebsiteRead | null;
  github: GithubRead | null;
  /** Social URLs supplied by the token listing (DexScreener), unverified. */
  listed_socials: string[];
}

export const NOT_CHECKED: ProjectFootprint = {
  checked: false,
  website: null,
  github: null,
  listed_socials: [],
};

/**
 * Read a project's off-chain footprint from the URLs a token listing carries.
 * Bounded: at most one page fetch + two GitHub calls. Never throws.
 */
export async function fetchProjectFootprint(
  websiteUrls: string[],
  socialUrls: string[],
): Promise<ProjectFootprint> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const siteUrl = websiteUrls.find(Boolean) ?? null;
  if (!siteUrl && socialUrls.length === 0) {
    // Nothing was ever listed. That IS a finding (a token with no site and no
    // socials), so it counts as checked.
    return { checked: true, website: null, github: null, listed_socials: [] };
  }

  let website: WebsiteRead | null = null;
  if (siteUrl) {
    try {
      const page = await fetchPage(siteUrl, deadline);
      if (!page) {
        website = {
          url: siteUrl,
          reachable: false,
          status: null,
          title: null,
          description: null,
          claims: null,
          category: null,
          publisher: null,
          links: {},
        };
      } else {
        const { html } = page;
        const ld = jsonLdBlocks(html);
        const withDesc = ld.find((b) => b.description) ?? ld[0];
        const publisher =
          ld.map((b) => b.publisher?.name ?? b.author?.name).find(Boolean) ??
          meta(html, 'publisher') ??
          meta(html, 'author') ??
          null;
        const sameAs = ld.flatMap((b) => [...(b.sameAs ?? []), ...(b.publisher?.sameAs ?? [])]);

        website = {
          url: page.finalUrl,
          reachable: page.status >= 200 && page.status < 300 && html.length > 0,
          status: page.status,
          title: clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1], 200),
          description: clean(meta(html, 'description') ?? meta(html, 'og:description')),
          claims: clean(withDesc?.description, 600),
          category:
            clean(withDesc?.applicationCategory, 120) ?? clean(meta(html, 'category'), 120),
          publisher: clean(publisher, 120),
          links: extractLinks(html, sameAs),
        };
      }
    } catch (e) {
      console.warn(`[footprint] website ${siteUrl}: ${(e as Error).message}`);
      website = {
        url: siteUrl,
        reachable: false,
        status: null,
        title: null,
        description: null,
        claims: null,
        category: null,
        publisher: null,
        links: {},
      };
    }
  }

  // GitHub from the site, else from the listed socials.
  const ghUrl =
    website?.links.github ?? socialUrls.find((u) => /github\.com/i.test(u)) ?? null;
  let github: GithubRead | null = null;
  if (ghUrl) {
    github = await fetchGithub(ghUrl, deadline).catch((e) => {
      console.warn(`[footprint] github ${ghUrl}: ${(e as Error).message}`);
      return null;
    });
  }

  return { checked: true, website, github, listed_socials: socialUrls };
}
