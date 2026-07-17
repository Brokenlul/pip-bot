import { rasterizeSvg } from './candle-chart.js';
import { fmtUtcHm } from './util.js';
import type { OrderFlowChartData, OiCvdChartData } from '../data/order-flow.js';

/**
 * Pip-branded order-flow chart: a market-depth view (cumulative bid vs ask
 * resting liquidity around mid) with a CVD strip underneath (cumulative
 * aggressor delta over the recent tape). Same hand-built-SVG -> resvg -> PNG
 * pipeline and palette as the candlestick chart. Book-only markets (Hyperliquid
 * fallback) render just the depth pane and say tape flow is unavailable.
 */

const BG = '#0D1311';
const GRID = '#1D2822';
const GREEN = '#12A15A'; // bids / positive CVD
const CLAY = '#C25B37'; // asks / negative CVD
const TEXT = '#E8EDEA';
const MUTED = '#8FA398';
const FAINT = '#5C6E64';

const W = 1200;
const PAD_L = 70;
const PAD_R = 70;
const PAD_T = 58;
const DEPTH_H = 340;
const GAP = 30;
const CVD_H = 150;
const FOOTER_H = 40;

const r1 = (n: number) => Math.round(n * 10) / 10;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (p >= 1) return p.toFixed(2);
  return p.toPrecision(4);
}
function fmtSize(s: number): string {
  if (s >= 1_000_000) return `${(s / 1_000_000).toFixed(1)}M`;
  if (s >= 1000) return `${(s / 1000).toFixed(1)}k`;
  if (s >= 1) return s.toFixed(0);
  return s.toFixed(2);
}

interface Level {
  px: number;
  sz: number;
}

/** Cumulative curve for one side, {px, cum} in cumulation order (from best out). */
function cumulative(levels: Level[], side: 'bid' | 'ask'): { px: number; cum: number }[] {
  // bids: cumulate from best (high px) downward; asks: from best (low px) upward.
  const ordered = side === 'bid' ? [...levels].sort((a, b) => b.px - a.px) : [...levels].sort((a, b) => a.px - b.px);
  let cum = 0;
  return ordered.map((l) => {
    cum += l.sz;
    return { px: l.px, cum };
  });
}

export function renderOrderFlowChartPng(d: OrderFlowChartData): Buffer {
  const hasCvd = Boolean(d.cvd && d.cvd.length > 1);
  const H = PAD_T + DEPTH_H + (hasCvd ? GAP + CVD_H : 0) + FOOTER_H;
  const x0 = PAD_L;
  const x1 = W - PAD_R;
  const plotW = x1 - x0;

  // Zoom the price axis to the actual near book (Binance returns ~1000 levels at
  // tick granularity, i.e. a tight range around mid). Cap the depth we plot so a
  // few far levels can't stretch the axis flat.
  const CAP = 400;
  const bidsSet = d.bids.slice(0, CAP);
  const asksSet = d.asks.slice(0, CAP);
  const lo = Math.min(d.mid, ...bidsSet.map((l) => l.px));
  const hi = Math.max(d.mid, ...asksSet.map((l) => l.px));

  const bidCurve = cumulative(bidsSet, 'bid');
  const askCurve = cumulative(asksSet, 'ask');
  const maxCum = Math.max(1, ...bidCurve.map((p) => p.cum), ...askCurve.map((p) => p.cum));

  const xAt = (px: number) => x0 + ((px - lo) / (hi - lo)) * plotW;
  const depthTop = PAD_T;
  const depthBot = PAD_T + DEPTH_H;
  const yAt = (cum: number) => depthBot - (cum / maxCum) * DEPTH_H;

  const el: string[] = [];
  el.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);

  // Title + venue.
  el.push(`<text x="${x0}" y="34" font-size="22" font-weight="bold" fill="${TEXT}">${esc(d.coin)} · Order flow</text>`);
  const venueLabel = d.venue === 'binance-futures' ? 'Binance perp depth + CVD' : 'Hyperliquid depth (book only)';
  el.push(`<text x="${x1}" y="34" font-size="13" fill="${MUTED}" text-anchor="end">${venueLabel}</text>`);

  // Depth-pane horizontal gridlines + size axis.
  for (let g = 0; g <= 4; g++) {
    const cum = (maxCum * g) / 4;
    const yy = yAt(cum);
    el.push(`<line x1="${x0}" y1="${r1(yy)}" x2="${x1}" y2="${r1(yy)}" stroke="${GRID}" stroke-width="1"/>`);
    el.push(`<text x="${x0 - 10}" y="${r1(yy + 4)}" font-size="12" fill="${FAINT}" text-anchor="end">${fmtSize(cum)}</text>`);
  }

  // Cumulative depth areas (stepped) from the mid outward.
  const midX = xAt(d.mid);
  function areaPath(curve: { px: number; cum: number }[], side: 'bid' | 'ask'): string {
    if (!curve.length) return '';
    // Order so the path runs from mid outward, stepped.
    const pts = side === 'bid' ? [...curve].sort((a, b) => b.px - a.px) : [...curve].sort((a, b) => a.px - b.px);
    let dstr = `M ${r1(midX)} ${r1(depthBot)}`;
    let prevY = depthBot;
    for (const p of pts) {
      const px = r1(xAt(p.px));
      const py = r1(yAt(p.cum));
      dstr += ` L ${px} ${r1(prevY)} L ${px} ${py}`;
      prevY = py;
    }
    dstr += ` L ${r1(xAt(pts[pts.length - 1]!.px))} ${r1(depthBot)} Z`;
    return dstr;
  }
  el.push(`<path d="${areaPath(bidCurve, 'bid')}" fill="${GREEN}" opacity="0.22"/>`);
  el.push(`<path d="${areaPath(askCurve, 'ask')}" fill="${CLAY}" opacity="0.22"/>`);
  // Curve outlines.
  const outline = (curve: { px: number; cum: number }[], side: 'bid' | 'ask', color: string) => {
    const pts = side === 'bid' ? [...curve].sort((a, b) => b.px - a.px) : [...curve].sort((a, b) => a.px - b.px);
    let dstr = `M ${r1(midX)} ${r1(depthBot)}`;
    let prevY = depthBot;
    for (const p of pts) {
      const px = r1(xAt(p.px));
      const py = r1(yAt(p.cum));
      dstr += ` L ${px} ${r1(prevY)} L ${px} ${py}`;
      prevY = py;
    }
    el.push(`<path d="${dstr}" fill="none" stroke="${color}" stroke-width="2"/>`);
  };
  outline(bidCurve, 'bid', GREEN);
  outline(askCurve, 'ask', CLAY);

  // Mid line + label.
  el.push(`<line x1="${r1(midX)}" y1="${depthTop}" x2="${r1(midX)}" y2="${depthBot}" stroke="${MUTED}" stroke-width="1" stroke-dasharray="4 4"/>`);
  el.push(`<text x="${r1(midX)}" y="${depthTop - 6}" font-size="12" fill="${TEXT}" text-anchor="middle">mid ${fmtPrice(d.mid)}</text>`);

  // Price axis ticks (5 across the band).
  for (let i = 0; i <= 4; i++) {
    const px = lo + ((hi - lo) * i) / 4;
    el.push(`<text x="${r1(xAt(px))}" y="${depthBot + 18}" font-size="12" fill="${FAINT}" text-anchor="middle">${fmtPrice(px)}</text>`);
  }
  // Side legends near the baseline (by mid), where the curves are low, so they
  // never sit on top of the depth fill in the top corners.
  el.push(`<text x="${r1(midX) - 12}" y="${depthBot - 10}" font-size="13" fill="${GREEN}" text-anchor="end">◀ bids</text>`);
  el.push(`<text x="${r1(midX) + 12}" y="${depthBot - 10}" font-size="13" fill="${CLAY}">asks ▶</text>`);

  // ---- CVD strip -----------------------------------------------------------
  if (hasCvd && d.cvd) {
    const cvd = d.cvd;
    const cTop = depthBot + GAP + 22;
    const cBot = cTop + CVD_H - 22;
    const vs = cvd.map((p) => p.v);
    const vMax = Math.max(1e-9, ...vs.map(Math.abs));
    const t0 = cvd[0]!.t;
    const tSpan = Math.max(1, cvd[cvd.length - 1]!.t - t0);
    const cx = (t: number) => x0 + ((t - t0) / tSpan) * plotW;
    const cy = (v: number) => (cTop + cBot) / 2 - (v / vMax) * ((CVD_H - 44) / 2);
    const zeroY = cy(0);
    const last = cvd[cvd.length - 1]!.v;
    const cvdColor = last >= 0 ? GREEN : CLAY;

    el.push(`<text x="${x0}" y="${depthBot + GAP + 14}" font-size="13" fill="${MUTED}">CVD · cumulative delta over the tape (${cvd.length} trades)</text>`);
    el.push(`<line x1="${x0}" y1="${r1(zeroY)}" x2="${x1}" y2="${r1(zeroY)}" stroke="${GRID}" stroke-width="1"/>`);
    // Area to zero + line.
    let line = '';
    let area = `M ${r1(cx(t0))} ${r1(zeroY)}`;
    cvd.forEach((p, i) => {
      const X = r1(cx(p.t));
      const Y = r1(cy(p.v));
      line += `${i === 0 ? 'M' : 'L'} ${X} ${Y} `;
      area += ` L ${X} ${Y}`;
    });
    area += ` L ${r1(cx(cvd[cvd.length - 1]!.t))} ${r1(zeroY)} Z`;
    el.push(`<path d="${area}" fill="${cvdColor}" opacity="0.14"/>`);
    el.push(`<polyline points="${line.trim().replace(/M |L /g, '')}" fill="none" stroke="${cvdColor}" stroke-width="2"/>`);
    el.push(`<text x="${x1}" y="${r1(cy(last)) - 8}" font-size="13" fill="${cvdColor}" text-anchor="end">${last >= 0 ? '+' : ''}${fmtSize(last)}</text>`);
  }

  // Footer.
  const fy = H - 14;
  el.push(`<text x="${x0}" y="${fy}" font-size="12" fill="${FAINT}">Not financial advice · snapshot, resting size can be spoofed · ${fmtUtcHm(new Date())}</text>`);
  el.push(`<text x="${x1}" y="${fy}" font-size="12" fill="${FAINT}" text-anchor="end">pipinvest.xyz</text>`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="JetBrains Mono">${el.join('')}</svg>`;
  return rasterizeSvg(svg);
}

// ---- Open Interest + CVD chart (dual-axis time series) ---------------------

export function renderOiCvdChartPng(d: OiCvdChartData): Buffer {
  const OW = 1200;
  const oPadL = 84;
  const oPadR = 84;
  const oPadT = 58;
  const oPlotH = 400;
  const oFooter = 70;
  const OH = oPadT + oPlotH + oFooter;
  const ax0 = oPadL;
  const ax1 = OW - oPadR;
  const aTop = oPadT;
  const aBot = oPadT + oPlotH;

  const allT = [...d.oi.map((p) => p.t), ...d.cvd.map((p) => p.t)];
  const tMin = Math.min(...allT);
  const tMax = Math.max(...allT);
  const tx = (t: number) => ax0 + ((t - tMin) / (tMax - tMin || 1)) * (ax1 - ax0);

  const oiVals = d.oi.map((p) => p.v);
  const oiMin = Math.min(...oiVals);
  const oiMax = Math.max(...oiVals);
  const oiY = (v: number) => aBot - ((v - oiMin) / (oiMax - oiMin || 1)) * oPlotH;

  const cvdVals = d.cvd.map((p) => p.v);
  const cMax = Math.max(1e-9, ...cvdVals.map(Math.abs));
  const cvdY = (v: number) => (aTop + aBot) / 2 - (v / cMax) * (oPlotH / 2 - 10);

  const el: string[] = [];
  el.push(`<rect width="${OW}" height="${OH}" fill="${BG}"/>`);
  el.push(`<text x="${ax0}" y="34" font-size="22" font-weight="bold" fill="${TEXT}">${esc(d.coin)} · Open Interest + CVD</text>`);
  el.push(`<text x="${ax1}" y="34" font-size="13" fill="${MUTED}" text-anchor="end">${esc(d.interval)} · Binance perp</text>`);

  // Gridlines + OI axis (left).
  for (let g = 0; g <= 4; g++) {
    const v = oiMin + ((oiMax - oiMin) * g) / 4;
    const yy = oiY(v);
    el.push(`<line x1="${ax0}" y1="${r1(yy)}" x2="${ax1}" y2="${r1(yy)}" stroke="${GRID}" stroke-width="1"/>`);
    el.push(`<text x="${ax0 - 8}" y="${r1(yy + 4)}" font-size="11" fill="${GREEN}" text-anchor="end">${(v / 1000).toFixed(1)}k</text>`);
  }
  // CVD zero baseline (right axis reference).
  el.push(`<line x1="${ax0}" y1="${r1(cvdY(0))}" x2="${ax1}" y2="${r1(cvdY(0))}" stroke="${CLAY}" stroke-width="1" stroke-dasharray="3 4" opacity="0.5"/>`);
  el.push(`<text x="${ax1 + 8}" y="${r1(cvdY(0) + 4)}" font-size="11" fill="${CLAY}">0</text>`);
  el.push(`<text x="${ax1 + 8}" y="${r1(cvdY(cMax) + 4)}" font-size="11" fill="${CLAY}">+${(cMax / 1000).toFixed(1)}k</text>`);
  el.push(`<text x="${ax1 + 8}" y="${r1(cvdY(-cMax) + 4)}" font-size="11" fill="${CLAY}">-${(cMax / 1000).toFixed(1)}k</text>`);

  // OI line (green).
  const oiPts = d.oi.map((p) => `${r1(tx(p.t))},${r1(oiY(p.v))}`).join(' ');
  el.push(`<polyline points="${oiPts}" fill="none" stroke="${GREEN}" stroke-width="2"/>`);
  // CVD line (clay).
  const cvdPts = d.cvd.map((p) => `${r1(tx(p.t))},${r1(cvdY(p.v))}`).join(' ');
  el.push(`<polyline points="${cvdPts}" fill="none" stroke="${CLAY}" stroke-width="2"/>`);

  // Time axis (a few labels).
  for (let i = 0; i <= 4; i++) {
    const t = tMin + ((tMax - tMin) * i) / 4;
    const dt = new Date(t);
    const lbl = `${String(dt.getUTCMonth() + 1)}/${String(dt.getUTCDate())} ${String(dt.getUTCHours()).padStart(2, '0')}:00`;
    el.push(`<text x="${r1(tx(t))}" y="${aBot + 18}" font-size="11" fill="${FAINT}" text-anchor="middle">${lbl}</text>`);
  }

  // Legend row (below the time axis, above the footer).
  const legY = aBot + 40;
  el.push(`<circle cx="${ax0 + 6}" cy="${r1(legY - 4)}" r="5" fill="${GREEN}"/>`);
  el.push(`<text x="${ax0 + 18}" y="${r1(legY)}" font-size="13" fill="${TEXT}">Open interest ${d.oiChangePct >= 0 ? '+' : ''}${d.oiChangePct}% over window</text>`);
  el.push(`<circle cx="${ax0 + 360}" cy="${r1(legY - 4)}" r="5" fill="${CLAY}"/>`);
  el.push(`<text x="${ax0 + 372}" y="${r1(legY)}" font-size="13" fill="${TEXT}">CVD ${d.cvdEnd >= 0 ? '+' : ''}${(d.cvdEnd / 1000).toFixed(1)}k (net taker delta)</text>`);

  const fy = OH - 14;
  el.push(`<text x="${ax0}" y="${fy}" font-size="12" fill="${FAINT}">Not financial advice · OI up with price = new positioning; CVD = net aggressor delta · ${fmtUtcHm(new Date())}</text>`);
  el.push(`<text x="${ax1}" y="${fy}" font-size="12" fill="${FAINT}" text-anchor="end">pipinvest.xyz</text>`);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OW}" height="${OH}" font-family="JetBrains Mono">${el.join('')}</svg>`;
  return rasterizeSvg(svg);
}
