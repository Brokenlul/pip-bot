import { rasterizeSvg } from './candle-chart.js';
import { fmtUtcHm } from './util.js';

/**
 * Pip-branded profile chart: a horizontal histogram of activity by price, used
 * for both Volume Profile (volume traded at each level) and TPO / Market Profile
 * (time spent at each level). POC (point of control) and the 70% value area are
 * marked. Same hand-built-SVG -> resvg -> PNG pipeline and palette as the
 * candlestick chart. Built from OHLCV candles (volume distributed across each
 * candle's range), the standard free-data approximation.
 */

const BG = '#0D1311';
const GRID = '#1D2822';
const GREEN = '#12A15A';
const GREEN_DIM = '#1c4a35';
const GOLD = '#E8C15A'; // POC
const TEXT = '#E8EDEA';
const MUTED = '#8FA398';
const FAINT = '#5C6E64';

const W = 1000;
const PAD_L = 96; // room for price labels
const PAD_R = 30;
const PAD_T = 56;
const PLOT_H = 460;
const FOOTER_H = 40;

const r1 = (n: number) => Math.round(n * 10) / 10;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1) return p.toFixed(2);
  return p.toPrecision(4);
}
function fmtVal(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return v.toFixed(v >= 10 ? 0 : 1);
}

export interface ProfileBucket {
  price: number; // bucket center
  value: number; // volume or time
}
export interface ProfileChartData {
  coin: string;
  mode: 'volume' | 'tpo';
  interval: string;
  buckets: ProfileBucket[]; // ascending by price
  poc: number; // price of the point of control
  vaLow: number;
  vaHigh: number;
  last: number; // current price
}

export function renderProfileChartPng(d: ProfileChartData): Buffer {
  const H = PAD_T + PLOT_H + FOOTER_H;
  const x0 = PAD_L;
  const x1 = W - PAD_R;
  const plotW = x1 - x0;
  const top = PAD_T;
  const bot = PAD_T + PLOT_H;

  const prices = d.buckets.map((b) => b.price);
  const pLo = Math.min(...prices);
  const pHi = Math.max(...prices);
  const maxVal = Math.max(1, ...d.buckets.map((b) => b.value));
  const yAt = (price: number) => bot - ((price - pLo) / (pHi - pLo || 1)) * PLOT_H;
  const barH = Math.max(2, PLOT_H / d.buckets.length - 1);

  const el: string[] = [];
  el.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);

  const title = d.mode === 'volume' ? 'Volume Profile' : 'Market Profile (TPO)';
  el.push(`<text x="${x0}" y="34" font-size="22" font-weight="bold" fill="${TEXT}">${esc(d.coin)} · ${title}</text>`);
  el.push(`<text x="${x1}" y="34" font-size="13" fill="${MUTED}" text-anchor="end">${esc(d.interval)} · ${d.mode === 'volume' ? 'volume at price' : 'time at price'}</text>`);

  // Value-area band (shaded).
  const vaTop = yAt(d.vaHigh);
  const vaBot = yAt(d.vaLow);
  el.push(`<rect x="${x0}" y="${r1(vaTop)}" width="${plotW}" height="${r1(vaBot - vaTop)}" fill="${GREEN}" opacity="0.06"/>`);

  // Horizontal bars, one per bucket.
  for (const b of d.buckets) {
    const w = (b.value / maxVal) * plotW;
    const y = yAt(b.price) - barH / 2;
    const isPoc = Math.abs(b.price - d.poc) < 1e-9;
    const inVa = b.price >= d.vaLow && b.price <= d.vaHigh;
    const color = isPoc ? GOLD : inVa ? GREEN : GREEN_DIM;
    el.push(`<rect x="${x0}" y="${r1(y)}" width="${r1(Math.max(1, w))}" height="${r1(barH)}" fill="${color}" opacity="${isPoc ? 0.95 : 0.8}" rx="1"/>`);
  }

  // Price axis labels (~8 across the range).
  for (let i = 0; i <= 8; i++) {
    const price = pLo + ((pHi - pLo) * i) / 8;
    el.push(`<text x="${x0 - 10}" y="${r1(yAt(price) + 4)}" font-size="12" fill="${FAINT}" text-anchor="end">${fmtPrice(price)}</text>`);
    el.push(`<line x1="${x0}" y1="${r1(yAt(price))}" x2="${x1}" y2="${r1(yAt(price))}" stroke="${GRID}" stroke-width="1" opacity="0.4"/>`);
  }

  // POC line + label.
  const pocY = yAt(d.poc);
  el.push(`<line x1="${x0}" y1="${r1(pocY)}" x2="${x1}" y2="${r1(pocY)}" stroke="${GOLD}" stroke-width="1" stroke-dasharray="5 3" opacity="0.8"/>`);
  el.push(`<text x="${x1 - 6}" y="${r1(pocY - 6)}" font-size="12" fill="${GOLD}" text-anchor="end">POC ${fmtPrice(d.poc)}</text>`);

  // Current price marker.
  const lastY = yAt(d.last);
  if (d.last >= pLo && d.last <= pHi) {
    el.push(`<line x1="${x0}" y1="${r1(lastY)}" x2="${x1}" y2="${r1(lastY)}" stroke="${TEXT}" stroke-width="1" opacity="0.6"/>`);
    el.push(`<text x="${x1 - 6}" y="${r1(lastY + 15)}" font-size="12" fill="${TEXT}" text-anchor="end">price ${fmtPrice(d.last)}</text>`);
  }

  // VA labels (left).
  el.push(`<text x="${x0 + 6}" y="${r1(vaTop + 14)}" font-size="11" fill="${MUTED}">VAH ${fmtPrice(d.vaHigh)}</text>`);
  el.push(`<text x="${x0 + 6}" y="${r1(vaBot - 6)}" font-size="11" fill="${MUTED}">VAL ${fmtPrice(d.vaLow)}</text>`);
  // Max-value scale hint (bottom-right).
  el.push(`<text x="${x1}" y="${bot + 20}" font-size="11" fill="${FAINT}" text-anchor="end">peak ${fmtVal(maxVal)} ${d.mode === 'volume' ? 'vol' : 'periods'} · gold = POC · shaded = 70% value area</text>`);

  // Footer.
  const fy = H - 14;
  el.push(`<text x="${x0}" y="${fy}" font-size="12" fill="${FAINT}">Not financial advice · ${d.interval} profile from candles · ${fmtUtcHm(new Date())}</text>`);
  el.push(`<text x="${x1}" y="${fy}" font-size="12" fill="${FAINT}" text-anchor="end">pipinvest.xyz</text>`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="JetBrains Mono">${el.join('')}</svg>`;
  return rasterizeSvg(svg);
}
