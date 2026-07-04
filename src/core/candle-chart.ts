import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { fmtUtcHm } from './util.js';

/**
 * Pip-branded candlestick chart renderer. Pure SVG built by hand (full control
 * of the brand look, no chart lib, no browser), rasterized to PNG via resvg
 * with the bundled JetBrains Mono (assets/fonts — OFL, safe to commit).
 *
 * Brand: green-on-mist dark. Up candles Pip Green #12A15A, down candles Clay
 * #C25B37 (same pair as the Discord embed side-bar), white "pip" roundel like
 * the bot avatar, "Not financial advice" footer baked into the image.
 */

export interface Candle {
  t: number; // open time ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type LevelKind = 'entry' | 'stop' | 'target' | 'level';

export interface ChartLevel {
  price: number;
  label?: string;
  kind?: LevelKind;
}

export interface ChartSpec {
  title: string; // e.g. "LINK · 1H"
  subtitle?: string; // e.g. "Hyperliquid perp"
  candles: Candle[];
  levels?: ChartLevel[];
  asOf?: Date;
}

// ---- palette ---------------------------------------------------------------
const BG = '#0D1311';
const GRID = '#1D2822';
const UP = '#12A15A';
const DOWN = '#C25B37';
const TEXT = '#E8EDEA';
const MUTED = '#8FA398';
const FAINT = '#5C6E64';

const LEVEL_COLOR: Record<LevelKind, string> = {
  entry: '#E8EDEA',
  stop: DOWN,
  target: UP,
  level: '#7E93FF',
};

const W = 1200;
const H = 675;

export function candleChartSvg(spec: ChartSpec): string {
  const candles = spec.candles;
  if (candles.length < 2) throw new Error('need at least 2 candles to draw a chart');

  const padL = 20;
  const padR = 92;
  const padT = 66;
  const padB = 58;
  const x0 = padL;
  const x1 = W - padR;
  const plotW = x1 - x0;

  const volH = 74;
  const py0 = padT; // price area top
  const py1 = H - padB - volH - 10; // price area bottom
  const vy1 = H - padB; // volume bottom

  // Price domain: candle range, widened by any drawable level (levels far
  // outside the candle range are skipped rather than squashing the candles).
  let lo = Math.min(...candles.map((c) => c.l));
  let hi = Math.max(...candles.map((c) => c.h));
  const span = hi - lo || hi * 0.01 || 1;
  const drawable = (spec.levels ?? []).filter(
    (lv) => Number.isFinite(lv.price) && lv.price > 0 && lv.price >= lo - span * 0.6 && lv.price <= hi + span * 0.6,
  );
  for (const lv of drawable) {
    lo = Math.min(lo, lv.price);
    hi = Math.max(hi, lv.price);
  }
  const pad = (hi - lo) * 0.05 || hi * 0.005 || 1;
  lo -= pad;
  hi += pad;

  const y = (p: number) => py1 - ((p - lo) / (hi - lo)) * (py1 - py0);
  const xAt = (i: number) => x0 + ((i + 0.5) / candles.length) * plotW;
  const cw = Math.max(2, Math.min(18, (plotW / candles.length) * 0.62));

  const el: string[] = [];
  el.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);

  // ---- horizontal grid + price ticks ----
  const step = niceStep((hi - lo) / 5.5);
  const firstTick = Math.ceil(lo / step) * step;
  for (let p = firstTick; p <= hi; p += step) {
    const yy = y(p);
    el.push(`<line x1="${x0}" y1="${r1(yy)}" x2="${x1}" y2="${r1(yy)}" stroke="${GRID}" stroke-width="1"/>`);
    el.push(
      `<text x="${x1 + 10}" y="${r1(yy + 4)}" font-size="12" fill="${MUTED}">${fmtPrice(p)}</text>`,
    );
  }

  // ---- time ticks ----
  const intradayMs = candles[1]!.t - candles[0]!.t;
  const tickCount = 6;
  for (let k = 0; k < tickCount; k++) {
    const i = Math.min(candles.length - 1, Math.round((k / (tickCount - 1)) * (candles.length - 1)));
    const xx = xAt(i);
    el.push(`<line x1="${r1(xx)}" y1="${py0}" x2="${r1(xx)}" y2="${vy1}" stroke="${GRID}" stroke-width="1"/>`);
    const anchor = k === 0 ? 'start' : k === tickCount - 1 ? 'end' : 'middle';
    el.push(
      `<text x="${r1(xx)}" y="${vy1 + 20}" font-size="12" fill="${MUTED}" text-anchor="${anchor}">${fmtTime(candles[i]!.t, intradayMs)}</text>`,
    );
  }

  // ---- volume bars ----
  // Scale to the 95th percentile, not the max — one outlier spike would
  // otherwise flatten every other bar to invisibility. Bars above it clamp.
  const sortedV = candles.map((c) => c.v).sort((a, b) => a - b);
  const vScale = Math.max(sortedV[Math.floor(sortedV.length * 0.95)] ?? 1, 1);
  candles.forEach((c, i) => {
    const hgt = Math.max(1, Math.min(1, c.v / vScale) * (volH - 6));
    const color = c.c >= c.o ? UP : DOWN;
    el.push(
      `<rect x="${r1(xAt(i) - cw / 2)}" y="${r1(vy1 - hgt)}" width="${r1(cw)}" height="${r1(hgt)}" fill="${color}" opacity="0.38"/>`,
    );
  });

  // ---- candles ----
  candles.forEach((c, i) => {
    const xx = xAt(i);
    const color = c.c >= c.o ? UP : DOWN;
    el.push(
      `<line x1="${r1(xx)}" y1="${r1(y(c.h))}" x2="${r1(xx)}" y2="${r1(y(c.l))}" stroke="${color}" stroke-width="1.4"/>`,
    );
    const top = y(Math.max(c.o, c.c));
    const hgt = Math.max(1.4, Math.abs(y(c.o) - y(c.c)));
    el.push(
      `<rect x="${r1(xx - cw / 2)}" y="${r1(top)}" width="${r1(cw)}" height="${r1(hgt)}" fill="${color}" rx="1"/>`,
    );
  });

  // ---- level lines ----
  for (const lv of drawable) {
    const kind: LevelKind = lv.kind ?? 'level';
    const color = LEVEL_COLOR[kind];
    const yy = y(lv.price);
    el.push(
      `<line x1="${x0}" y1="${r1(yy)}" x2="${x1}" y2="${r1(yy)}" stroke="${color}" stroke-width="1.4" stroke-dasharray="7 5" opacity="0.9"/>`,
    );
    // price chip on the right axis
    el.push(chip(x1 + 6, yy, fmtPrice(lv.price), color, BG));
    // label above the line, left side
    if (lv.label) {
      el.push(
        `<text x="${x0 + 8}" y="${r1(yy - 7)}" font-size="12" fill="${color}">${esc(truncate(lv.label, 34))}</text>`,
      );
    }
  }

  // ---- last price marker ----
  const last = candles[candles.length - 1]!;
  const lastColor = last.c >= last.o ? UP : DOWN;
  const ly = y(last.c);
  el.push(
    `<line x1="${x0}" y1="${r1(ly)}" x2="${x1}" y2="${r1(ly)}" stroke="${lastColor}" stroke-width="1" stroke-dasharray="2 4" opacity="0.85"/>`,
  );
  el.push(chip(x1 + 6, ly, fmtPrice(last.c), lastColor, BG, true));

  // ---- header ----
  el.push(
    `<text x="${padL}" y="30" font-size="22" font-weight="bold" fill="${TEXT}">${esc(spec.title)}</text>`,
  );
  if (spec.subtitle) {
    el.push(`<text x="${padL}" y="50" font-size="13" fill="${MUTED}">${esc(spec.subtitle)}</text>`);
  }
  const chg = ((last.c - candles[0]!.o) / candles[0]!.o) * 100;
  const chgColor = chg >= 0 ? UP : DOWN;
  const chgText = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% over window`;
  el.push(
    `<text x="${W - padR - 46}" y="30" font-size="14" fill="${chgColor}" text-anchor="end">${chgText}</text>`,
  );

  // ---- pip roundel (mirrors the bot avatar: white circle, dark "pip") ----
  el.push(`<circle cx="${W - 44}" cy="26" r="17" fill="#F2F4F1"/>`);
  el.push(
    `<text x="${W - 44}" y="31" font-size="13" font-weight="bold" fill="#10160F" text-anchor="middle">pip</text>`,
  );

  // ---- footer ----
  el.push(
    `<text x="${padL}" y="${H - 12}" font-size="11" fill="${FAINT}">as of ${fmtUtcHm(spec.asOf ?? new Date())}</text>`,
  );
  el.push(
    `<text x="${W - 20}" y="${H - 12}" font-size="11" fill="${FAINT}" text-anchor="end">Not financial advice</text>`,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="JetBrains Mono">${el.join('')}</svg>`;
}

/**
 * Locate assets/fonts relative to THIS module (src/core or dist/core are both
 * two levels below the repo root), falling back to cwd. A cwd-only resolve
 * fails silently — resvg just renders no text — when the process starts
 * outside the repo root.
 */
function fontsDirPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const local = path.resolve(here, '..', '..', 'assets', 'fonts');
  if (existsSync(local)) return local;
  return path.resolve(process.cwd(), 'assets', 'fonts');
}

/** Rasterize the branded SVG to a PNG buffer (Discord/Telegram attachment). */
export function renderCandleChartPng(spec: ChartSpec): Buffer {
  const svg = candleChartSvg(spec);
  const fontsDir = fontsDirPath();
  if (!existsSync(path.join(fontsDir, 'JetBrainsMono-Regular.ttf'))) {
    // Fail loudly — a chart with invisible text must never ship to a user.
    throw new Error(`chart fonts not found at ${fontsDir}`);
  }
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [
        path.join(fontsDir, 'JetBrainsMono-Regular.ttf'),
        path.join(fontsDir, 'JetBrainsMono-Bold.ttf'),
      ],
      loadSystemFonts: false,
      defaultFontFamily: 'JetBrains Mono',
    },
  });
  return Buffer.from(resvg.render().asPng());
}

// ---- helpers ----------------------------------------------------------------

/** Right-axis price tag: filled for the live price, outlined for levels. */
function chip(x: number, yy: number, text: string, color: string, bg: string, filled = false): string {
  const w = text.length * 7.3 + 12;
  const h = 18;
  const fill = filled ? color : bg;
  const fg = filled ? bg : color;
  return (
    `<rect x="${r1(x)}" y="${r1(yy - h / 2)}" width="${r1(w)}" height="${h}" rx="3" fill="${fill}" stroke="${color}" stroke-width="1"/>` +
    `<text x="${r1(x + 6)}" y="${r1(yy + 4)}" font-size="12" fill="${fg}">${esc(text)}</text>`
  );
}

function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * mag;
}

function fmtPrice(p: number): string {
  if (p >= 10_000) return Math.round(p).toLocaleString('en-US');
  if (p >= 1_000) return p.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(3);
  return parseFloat(p.toPrecision(4)).toString();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtTime(t: number, intervalMs: number): string {
  const d = new Date(t);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = MONTHS[d.getUTCMonth()];
  if (intervalMs >= 24 * 3600_000) return `${dd} ${mon}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd} ${mon} ${hh}:${mm}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function r1(n: number): number {
  return Math.round(n * 10) / 10;
}
