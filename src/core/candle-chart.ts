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
 *
 * Beyond candles + levels it draws indicator overlays (EMA/SMA/VWAP lines,
 * a Bollinger band), shaded zones (FVGs), and oscillator sub-panes (MACD,
 * RSI) below the volume strip — the height grows per sub-pane.
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

/** A line plotted over the price pane (EMA/SMA/VWAP…). Aligned to candles. */
export interface OverlayLine {
  label: string;
  color: string;
  points: (number | null)[];
  dashed?: boolean;
}

/** A shaded channel over the price pane (Bollinger). Aligned to candles. */
export interface BandOverlay {
  label: string;
  color: string;
  upper: (number | null)[];
  lower: (number | null)[];
}

/** A shaded horizontal zone (FVG / supply-demand box) from a candle onward. */
export interface ChartZone {
  top: number;
  bottom: number;
  fromIndex: number;
  color: string;
  label?: string;
}

export interface SubPaneSeries {
  label: string;
  color: string;
  points: (number | null)[];
  dashed?: boolean;
}

/** An oscillator pane under the chart (MACD, RSI…). */
export interface SubPane {
  title: string;
  series: SubPaneSeries[];
  histogram?: { points: (number | null)[]; posColor: string; negColor: string };
  /** Fixed domain (e.g. RSI 0–100); defaults to the data's own range. */
  yDomain?: [number, number];
  /** Dashed horizontal guide values (e.g. 0 for MACD, 30/70 for RSI). */
  guides?: number[];
}

export interface ChartSpec {
  title: string; // e.g. "LINK · 1H"
  subtitle?: string; // e.g. "Hyperliquid perp"
  candles: Candle[];
  levels?: ChartLevel[];
  overlays?: OverlayLine[];
  band?: BandOverlay;
  zones?: ChartZone[];
  subPanes?: SubPane[];
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
const PAD_L = 20;
const PAD_R = 92;
const PAD_T = 66;
const PRICE_H = 491;
const VOL_H = 64;
const PANE_H = 104;
const GAP = 8;
const TIME_AXIS_H = 26;
const FOOTER_H = 20;

export function candleChartSvg(spec: ChartSpec): string {
  const candles = spec.candles;
  if (candles.length < 2) throw new Error('need at least 2 candles to draw a chart');

  const panes = spec.subPanes ?? [];
  const H = PAD_T + PRICE_H + GAP + VOL_H + panes.length * (GAP + PANE_H) + TIME_AXIS_H + FOOTER_H;

  const x0 = PAD_L;
  const x1 = W - PAD_R;
  const plotW = x1 - x0;
  const py0 = PAD_T;
  const py1 = PAD_T + PRICE_H;
  const vy0 = py1 + GAP;
  const vy1 = vy0 + VOL_H;
  const gridBottom = vy1 + panes.length * (GAP + PANE_H);

  // Price domain: candle range widened by drawable levels/zones/overlays that
  // sit near it (far-out levels are skipped rather than squashing the candles).
  let lo = Math.min(...candles.map((c) => c.l));
  let hi = Math.max(...candles.map((c) => c.h));
  const span = hi - lo || hi * 0.01 || 1;
  const drawableLevels = (spec.levels ?? []).filter(
    (lv) => Number.isFinite(lv.price) && lv.price > 0 && lv.price >= lo - span * 0.6 && lv.price <= hi + span * 0.6,
  );
  for (const lv of drawableLevels) {
    lo = Math.min(lo, lv.price);
    hi = Math.max(hi, lv.price);
  }
  for (const s of [...(spec.overlays ?? []), ...(spec.band ? [{ points: spec.band.upper }, { points: spec.band.lower }] : [])]) {
    for (const v of s.points) {
      if (v == null) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
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
    el.push(`<text x="${x1 + 10}" y="${r1(yy + 4)}" font-size="12" fill="${MUTED}">${fmtPrice(p)}</text>`);
  }

  // ---- time ticks (vertical lines span price, volume, and sub-panes) ----
  const intradayMs = candles[1]!.t - candles[0]!.t;
  const tickCount = 6;
  for (let k = 0; k < tickCount; k++) {
    const i = Math.min(candles.length - 1, Math.round((k / (tickCount - 1)) * (candles.length - 1)));
    const xx = xAt(i);
    el.push(`<line x1="${r1(xx)}" y1="${py0}" x2="${r1(xx)}" y2="${gridBottom}" stroke="${GRID}" stroke-width="1"/>`);
    const anchor = k === 0 ? 'start' : k === tickCount - 1 ? 'end' : 'middle';
    el.push(
      `<text x="${r1(xx)}" y="${gridBottom + 18}" font-size="12" fill="${MUTED}" text-anchor="${anchor}">${fmtTime(candles[i]!.t, intradayMs)}</text>`,
    );
  }

  // ---- shaded zones (FVGs) — behind candles ----
  for (const z of spec.zones ?? []) {
    const zt = Math.min(Math.max(z.top, lo), hi);
    const zb = Math.min(Math.max(z.bottom, lo), hi);
    if (zt === zb) continue;
    const zx = xAt(Math.max(0, Math.min(z.fromIndex, candles.length - 1)));
    el.push(
      `<rect x="${r1(zx)}" y="${r1(y(zt))}" width="${r1(x1 - zx)}" height="${r1(y(zb) - y(zt))}" fill="${z.color}" opacity="0.12"/>`,
    );
    el.push(
      `<line x1="${r1(zx)}" y1="${r1(y(zt))}" x2="${x1}" y2="${r1(y(zt))}" stroke="${z.color}" stroke-width="1" stroke-dasharray="3 4" opacity="0.4"/>`,
    );
    el.push(
      `<line x1="${r1(zx)}" y1="${r1(y(zb))}" x2="${x1}" y2="${r1(y(zb))}" stroke="${z.color}" stroke-width="1" stroke-dasharray="3 4" opacity="0.4"/>`,
    );
    if (z.label) {
      el.push(
        `<text x="${r1(zx + 4)}" y="${r1(y(zt) + 13)}" font-size="10" fill="${z.color}" opacity="0.85">${esc(z.label)}</text>`,
      );
    }
  }

  // ---- Bollinger-style band — behind candles ----
  if (spec.band) {
    const area = bandPath(spec.band.upper, spec.band.lower, xAt, y);
    if (area) el.push(`<path d="${area}" fill="${spec.band.color}" opacity="0.10"/>`);
    for (const edge of [spec.band.upper, spec.band.lower]) {
      for (const seg of polylines(edge, xAt, y)) {
        el.push(`<polyline points="${seg}" fill="none" stroke="${spec.band.color}" stroke-width="1" opacity="0.5"/>`);
      }
    }
  }

  // ---- volume bars ----
  // Scale to the 95th percentile, not the max — one outlier spike would
  // otherwise flatten every other bar to invisibility. Bars above it clamp.
  const sortedV = candles.map((c) => c.v).sort((a, b) => a - b);
  const vScale = Math.max(sortedV[Math.floor(sortedV.length * 0.95)] ?? 1, 1);
  candles.forEach((c, i) => {
    const hgt = Math.max(1, Math.min(1, c.v / vScale) * (VOL_H - 6));
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

  // ---- indicator overlay lines ----
  for (const ov of spec.overlays ?? []) {
    const dash = ov.dashed ? ' stroke-dasharray="5 4"' : '';
    for (const seg of polylines(ov.points, xAt, y)) {
      el.push(`<polyline points="${seg}" fill="none" stroke="${ov.color}" stroke-width="1.6"${dash} opacity="0.95"/>`);
    }
  }

  // ---- level lines ----
  for (const lv of drawableLevels) {
    const kind: LevelKind = lv.kind ?? 'level';
    const color = LEVEL_COLOR[kind];
    const yy = y(lv.price);
    el.push(
      `<line x1="${x0}" y1="${r1(yy)}" x2="${x1}" y2="${r1(yy)}" stroke="${color}" stroke-width="1.4" stroke-dasharray="7 5" opacity="0.9"/>`,
    );
    el.push(chip(x1 + 6, yy, fmtPrice(lv.price), color, BG));
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

  // ---- sub-panes (MACD / RSI …) ----
  panes.forEach((pane, pi) => {
    const pt = vy1 + GAP + pi * (GAP + PANE_H) + (pi > 0 ? 0 : 0);
    const pb = pt + PANE_H;
    el.push(`<line x1="${x0}" y1="${pt}" x2="${x1}" y2="${pt}" stroke="${GRID}" stroke-width="1"/>`);
    el.push(`<text x="${x0 + 6}" y="${pt + 15}" font-size="11" fill="${MUTED}">${esc(pane.title)}</text>`);

    // Domain
    let plo = pane.yDomain?.[0] ?? Infinity;
    let phi = pane.yDomain?.[1] ?? -Infinity;
    if (!pane.yDomain) {
      const all = [
        ...pane.series.flatMap((s) => s.points),
        ...(pane.histogram?.points ?? []),
        ...(pane.guides ?? []),
      ];
      for (const v of all) {
        if (v == null) continue;
        plo = Math.min(plo, v);
        phi = Math.max(phi, v);
      }
      if (!Number.isFinite(plo) || plo === phi) {
        plo = -1;
        phi = 1;
      }
      const ppad = (phi - plo) * 0.12;
      plo -= ppad;
      phi += ppad;
    }
    const pyf = (v: number) => pb - ((v - plo) / (phi - plo)) * (PANE_H - 20) - 4;

    for (const g of pane.guides ?? []) {
      if (g < plo || g > phi) continue;
      el.push(
        `<line x1="${x0}" y1="${r1(pyf(g))}" x2="${x1}" y2="${r1(pyf(g))}" stroke="${FAINT}" stroke-width="1" stroke-dasharray="4 4" opacity="0.6"/>`,
      );
      el.push(`<text x="${x1 + 10}" y="${r1(pyf(g) + 4)}" font-size="11" fill="${FAINT}">${fmtPrice(g)}</text>`);
    }

    if (pane.histogram) {
      const zero = pyf(Math.max(plo, Math.min(0, phi)));
      pane.histogram.points.forEach((v, i) => {
        if (v == null) return;
        const yy = pyf(v);
        const color = v >= 0 ? pane.histogram!.posColor : pane.histogram!.negColor;
        el.push(
          `<rect x="${r1(xAt(i) - cw * 0.4)}" y="${r1(Math.min(yy, zero))}" width="${r1(cw * 0.8)}" height="${r1(Math.max(1, Math.abs(zero - yy)))}" fill="${color}" opacity="0.55"/>`,
        );
      });
    }

    for (const s of pane.series) {
      const dash = s.dashed ? ' stroke-dasharray="5 4"' : '';
      for (const seg of polylines(s.points, xAt, pyf)) {
        el.push(`<polyline points="${seg}" fill="none" stroke="${s.color}" stroke-width="1.5"${dash}/>`);
      }
    }

    // Live value chip for the first series (the pane's primary line).
    const primary = pane.series[0];
    const lastVal = primary ? [...primary.points].reverse().find((v) => v != null) : null;
    if (primary && lastVal != null) {
      el.push(chip(x1 + 6, pyf(lastVal), fmtPrice(lastVal), primary.color, BG));
    }
  });

  // ---- header ----
  el.push(`<text x="${PAD_L}" y="30" font-size="22" font-weight="bold" fill="${TEXT}">${esc(spec.title)}</text>`);
  let legendX = PAD_L;
  if (spec.subtitle) {
    el.push(`<text x="${PAD_L}" y="50" font-size="13" fill="${MUTED}">${esc(spec.subtitle)}</text>`);
    legendX += spec.subtitle.length * 8 + 26;
  }
  // Overlay/band legend on the subtitle row, each entry in its own color.
  const legendItems = [
    ...(spec.overlays ?? []).map((o) => ({ label: o.label, color: o.color })),
    ...(spec.band ? [{ label: spec.band.label, color: spec.band.color }] : []),
  ];
  for (const item of legendItems) {
    el.push(`<line x1="${legendX}" y1="46" x2="${legendX + 14}" y2="46" stroke="${item.color}" stroke-width="2"/>`);
    el.push(`<text x="${legendX + 19}" y="50" font-size="12" fill="${item.color}">${esc(item.label)}</text>`);
    legendX += 19 + item.label.length * 7.3 + 18;
  }
  const chg = ((last.c - candles[0]!.o) / candles[0]!.o) * 100;
  const chgColor = chg >= 0 ? UP : DOWN;
  el.push(
    `<text x="${W - PAD_R - 46}" y="30" font-size="14" fill="${chgColor}" text-anchor="end">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}% over window</text>`,
  );

  // ---- pip roundel (mirrors the bot avatar: white circle, dark "pip") ----
  el.push(`<circle cx="${W - 44}" cy="26" r="17" fill="#F2F4F1"/>`);
  el.push(`<text x="${W - 44}" y="31" font-size="13" font-weight="bold" fill="#10160F" text-anchor="middle">pip</text>`);

  // ---- footer ----
  el.push(
    `<text x="${PAD_L}" y="${H - 8}" font-size="11" fill="${FAINT}">as of ${fmtUtcHm(spec.asOf ?? new Date())}</text>`,
  );
  el.push(
    `<text x="${W - 20}" y="${H - 8}" font-size="11" fill="${FAINT}" text-anchor="end">Not financial advice</text>`,
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

/** Rasterize any Pip-branded SVG to a PNG buffer with the bundled fonts. Shared
 *  by the candlestick chart and the order-flow chart. */
export function rasterizeSvg(svg: string): Buffer {
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

/** Rasterize the branded candlestick SVG to a PNG buffer (Discord/Telegram attachment). */
export function renderCandleChartPng(spec: ChartSpec): Buffer {
  return rasterizeSvg(candleChartSvg(spec));
}

// ---- helpers ----------------------------------------------------------------

/** Contiguous non-null runs of an aligned series → SVG polyline point lists. */
function polylines(
  points: (number | null)[],
  xAt: (i: number) => number,
  yAt: (v: number) => number,
): string[] {
  const out: string[] = [];
  let seg: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const v = points[i];
    if (v == null) {
      if (seg.length > 1) out.push(seg.join(' '));
      seg = [];
      continue;
    }
    seg.push(`${r1(xAt(i))},${r1(yAt(v))}`);
  }
  if (seg.length > 1) out.push(seg.join(' '));
  return out;
}

/** Closed path between the upper and lower series (shared non-null span). */
function bandPath(
  upper: (number | null)[],
  lower: (number | null)[],
  xAt: (i: number) => number,
  yAt: (v: number) => number,
): string | null {
  const idx: number[] = [];
  for (let i = 0; i < upper.length; i++) if (upper[i] != null && lower[i] != null) idx.push(i);
  if (idx.length < 2) return null;
  const top = idx.map((i) => `${r1(xAt(i))},${r1(yAt(upper[i]!))}`);
  const bottom = [...idx].reverse().map((i) => `${r1(xAt(i))},${r1(yAt(lower[i]!))}`);
  return `M${top.join(' L')} L${bottom.join(' L')} Z`;
}

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
  const abs = Math.abs(p);
  const sign = p < 0 ? '-' : '';
  if (abs >= 10_000) return sign + Math.round(abs).toLocaleString('en-US');
  if (abs >= 1_000) return sign + abs.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (abs >= 100) return sign + abs.toFixed(2);
  if (abs >= 1) return sign + abs.toFixed(3);
  if (abs === 0) return '0';
  return sign + parseFloat(abs.toPrecision(4)).toString();
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
