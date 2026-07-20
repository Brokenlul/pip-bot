import { rasterizeSvg } from './candle-chart.js';
import { fmtUtcHm } from './util.js';
import type { FootprintData, FpCandle } from '../data/footprint.js';

/**
 * Pip-branded footprint (cluster) chart: one column per candle, one row per
 * price bucket, each cell printing `bid x ask` — the volume that hit the bid
 * (sell aggressor) against the volume that lifted the ask (buy aggressor).
 *
 * Cell shading is driven by the DIAGONAL imbalances the data layer already
 * found, not by raw size, so the picture agrees with the text read. Under the
 * grid sits a per-candle delta bar row and the running cumulative delta.
 *
 * Density is the whole design problem: a footprint is unreadable past ~14
 * columns at Discord's render width, so the tool caps candles rather than
 * shrinking the type to unreadable.
 */

const BG = '#0D1311';
const GRID = '#1D2822';
const GREEN = '#12A15A';
const CLAY = '#C25B37';
const GOLD = '#E8C15A'; // POC
const TEXT = '#E8EDEA';
const MUTED = '#8FA398';
const FAINT = '#5C6E64';

const PAD_L = 92; // price axis
const PAD_R = 26;
const PAD_T = 58;
const COL_W = 116;
const ROW_H = 21;
const DELTA_GAP = 26; // grid bottom -> delta block
const DELTA_H = 96; // delta bars + their value labels, both sides of the zero line
const FOOTER_H = 76; // time axis + two footer lines, with clearance

const r1 = (n: number) => Math.round(n * 10) / 10;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Price labels must resolve to the BUCKET, not to a fixed 2dp — with a 0.002
 * tick, toFixed(2) prints "8.35" for three adjacent rows and the axis becomes
 * meaningless. Decimals come from the tick size.
 */
function decimalsFor(tick: number): number {
  if (tick >= 1) return 0;
  return Math.min(8, Math.ceil(-Math.log10(tick)));
}
function fmtPrice(p: number, tick: number): string {
  const dp = decimalsFor(tick);
  return p.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
/** Cell volumes must stay narrow — 4 chars max or the column blows out. */
function fmtVol(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(1);
  if (v > 0) return v.toFixed(2);
  return '·';
}
function fmtDelta(v: number): string {
  const s = v >= 0 ? '+' : '-';
  return s + fmtVol(Math.abs(v));
}
function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function renderFootprintChartPng(d: FootprintData): Buffer {
  const candles = d.candles;
  if (!candles.length) throw new Error('no footprint candles to render');

  // Price rows span every bucket touched anywhere in the window, so columns
  // share one price axis and a level reads straight across.
  const lo = Math.min(...candles.map((c) => Math.min(...c.cells.map((x) => x.price))));
  const hi = Math.max(...candles.map((c) => Math.max(...c.cells.map((x) => x.price))));
  const rows = Math.round((hi - lo) / d.tick) + 1;

  const W = PAD_L + candles.length * COL_W + PAD_R;
  const gridH = rows * ROW_H;
  const H = PAD_T + gridH + DELTA_GAP + DELTA_H + FOOTER_H;
  const x0 = PAD_L;
  const gridTop = PAD_T;
  const gridBot = gridTop + gridH;

  // Row 0 is the HIGHEST price — price axes read top-down.
  const rowY = (price: number) => gridTop + Math.round((hi - price) / d.tick) * ROW_H;
  const colX = (i: number) => x0 + i * COL_W;

  const el: string[] = [];
  el.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);
  el.push(`<text x="${x0 - 20}" y="34" font-size="22" font-weight="bold" fill="${TEXT}">${esc(d.coin)} · Footprint</text>`);
  const windowNote = `${d.interval} · ${d.candles.length} candles · ${d.trades.toLocaleString('en-US')} prints${d.truncated ? ' (capped)' : ''}`;
  el.push(`<text x="${W - PAD_R}" y="34" font-size="13" fill="${MUTED}" text-anchor="end">${windowNote} · Binance perp</text>`);

  // Price gridlines + labels.
  for (let r = 0; r < rows; r++) {
    const price = hi - r * d.tick;
    const y = gridTop + r * ROW_H;
    el.push(`<line x1="${x0}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`);
    el.push(`<text x="${x0 - 10}" y="${y + ROW_H / 2 + 4}" font-size="11" fill="${FAINT}" text-anchor="end">${fmtPrice(price, d.tick)}</text>`);
  }
  el.push(`<line x1="${x0}" y1="${gridBot}" x2="${W - PAD_R}" y2="${gridBot}" stroke="${GRID}" stroke-width="1"/>`);

  // Column separators.
  for (let i = 0; i <= candles.length; i++) {
    const x = colX(i);
    el.push(`<line x1="${x}" y1="${gridTop}" x2="${x}" y2="${gridBot}" stroke="${GRID}" stroke-width="1"/>`);
  }

  // ---- cells ---------------------------------------------------------------
  candles.forEach((c: FpCandle, i) => {
    const cx = colX(i);
    const imbAt = new Map(c.imbalances.map((m) => [`${m.price}:${m.side}`, m.ratio]));
    // Levels inside a stack get the stronger highlight — that's the tradeable one.
    const stacked = new Set<string>();
    for (const s of c.stacks) {
      for (let p = s.low; p <= s.high + d.tick * 0.01; p = p + d.tick) stacked.add(`${Math.round(p / d.tick)}:${s.side}`);
    }

    for (const cell of c.cells) {
      const y = rowY(cell.price);
      const key = Math.round(cell.price / d.tick);
      const bidImb = imbAt.has(`${cell.price}:bid`);
      const askImb = imbAt.has(`${cell.price}:ask`);
      const bidStack = stacked.has(`${key}:bid`);
      const askStack = stacked.has(`${key}:ask`);

      // POC band for the candle.
      if (cell.price === c.poc) {
        el.push(`<rect x="${cx + 1}" y="${y + 1}" width="${COL_W - 2}" height="${ROW_H - 2}" fill="${GOLD}" opacity="0.10"/>`);
      }
      // Imbalance highlights: half-cell tint on the side that's imbalanced.
      if (bidImb) el.push(`<rect x="${cx + 1}" y="${y + 1}" width="${COL_W / 2 - 1}" height="${ROW_H - 2}" fill="${CLAY}" opacity="${bidStack ? 0.42 : 0.2}"/>`);
      if (askImb) el.push(`<rect x="${cx + COL_W / 2}" y="${y + 1}" width="${COL_W / 2 - 1}" height="${ROW_H - 2}" fill="${GREEN}" opacity="${askStack ? 0.42 : 0.2}"/>`);

      const ty = y + ROW_H / 2 + 4;
      // bid (sell aggressor) left, ask (buy aggressor) right — the ladder convention.
      el.push(`<text x="${cx + COL_W / 2 - 8}" y="${ty}" font-size="11" fill="${bidImb ? TEXT : MUTED}" text-anchor="end" ${bidStack ? 'font-weight="bold"' : ''}>${fmtVol(cell.bid)}</text>`);
      el.push(`<text x="${cx + COL_W / 2}" y="${ty}" font-size="11" fill="${FAINT}" text-anchor="middle">×</text>`);
      el.push(`<text x="${cx + COL_W / 2 + 8}" y="${ty}" font-size="11" fill="${askImb ? TEXT : MUTED}" ${askStack ? 'font-weight="bold"' : ''}>${fmtVol(cell.ask)}</text>`);
    }
  });

  // ---- delta row -----------------------------------------------------------
  const dTop = gridBot + DELTA_GAP;
  const dMid = dTop + DELTA_H / 2;
  const maxBar = DELTA_H / 2 - 20; // leaves room for the value label outside the bar
  const maxAbs = Math.max(1e-9, ...candles.map((c) => Math.abs(c.delta)));
  el.push(`<text x="${x0 - 10}" y="${dMid + 4}" font-size="11" fill="${MUTED}" text-anchor="end">delta</text>`);
  candles.forEach((c, i) => {
    const cx = colX(i);
    const bw = COL_W - 34;
    const h = Math.max(2, (Math.abs(c.delta) / maxAbs) * maxBar);
    const up = c.delta >= 0;
    const color = up ? GREEN : CLAY;
    el.push(`<rect x="${cx + 17}" y="${r1(up ? dMid - h : dMid)}" width="${bw}" height="${r1(h)}" fill="${color}" opacity="0.75"/>`);
    // Label goes on the SAME side as its bar, just past the end — putting it
    // across the zero line reads as belonging to the neighbouring bar.
    el.push(`<text x="${cx + COL_W / 2}" y="${r1(up ? dMid - h - 6 : dMid + h + 14)}" font-size="11" fill="${color}" text-anchor="middle">${fmtDelta(c.delta)}</text>`);
  });
  el.push(`<line x1="${x0}" y1="${r1(dMid)}" x2="${W - PAD_R}" y2="${r1(dMid)}" stroke="${GRID}" stroke-width="1"/>`);

  // ---- time axis + footer --------------------------------------------------
  const axisY = dTop + DELTA_H + 16;
  candles.forEach((c, i) => {
    el.push(`<text x="${colX(i) + COL_W / 2}" y="${axisY}" font-size="11" fill="${FAINT}" text-anchor="middle">${hhmm(c.t)}</text>`);
  });

  const cumColor = d.cumDelta >= 0 ? GREEN : CLAY;
  const legendY = axisY + 26;
  el.push(`<text x="${x0 - 20}" y="${legendY}" font-size="12" fill="${MUTED}">bid × ask per level · <tspan fill="${GREEN}">green</tspan>/<tspan fill="${CLAY}">clay</tspan> = ${'≥'}3× diagonal imbalance, bold = stacked · <tspan fill="${GOLD}">gold</tspan> = candle POC</text>`);
  el.push(`<text x="${W - PAD_R}" y="${legendY}" font-size="12" fill="${cumColor}" text-anchor="end">window delta ${fmtDelta(d.cumDelta)}</text>`);
  el.push(`<text x="${x0 - 20}" y="${legendY + 20}" font-size="11" fill="${FAINT}">Not financial advice · ${d.windowMinutes}min of tape${d.truncated ? ' (window capped)' : ''} · ${fmtUtcHm(new Date())}</text>`);
  el.push(`<text x="${W - PAD_R}" y="${legendY + 20}" font-size="11" fill="${FAINT}" text-anchor="end">pipinvest.xyz</text>`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="JetBrains Mono">${el.join('')}</svg>`;
  return rasterizeSvg(svg);
}
