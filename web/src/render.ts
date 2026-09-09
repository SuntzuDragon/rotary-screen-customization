import { EVENT_LABEL, ago, compact } from './format';
import type { DeckId, DevicePayload, PayloadRepo } from './types';

export const SIZE = 240;
const R = SIZE / 2;
const CX = R;
const CY = R;

/**
 * Widest run of pixels available at a given y inside the circle, minus padding.
 * Every layout decision on a round panel comes back to this.
 */
export function widthAt(y: number, pad = 10): number {
  const dy = Math.abs(y - CY);
  if (dy >= R) return 0;
  return 2 * Math.sqrt(R * R - dy * dy) - pad * 2;
}

const TAU = Math.PI * 2;
const TOP = -Math.PI / 2; // 12 o'clock

interface Ctx2D extends CanvasRenderingContext2D {}

function font(ctx: Ctx2D, px: number, weight = 600) {
  ctx.font = `${weight} ${px}px Montserrat, "Segoe UI", system-ui, sans-serif`;
}

/** Shrink text until it fits, so a long repo name can never bleed off the disc. */
function fitText(ctx: Ctx2D, text: string, max: number, start: number, weight = 600): number {
  let px = start;
  font(ctx, px, weight);
  while (px > 8 && ctx.measureText(text).width > max) {
    px -= 1;
    font(ctx, px, weight);
  }
  return px;
}

function ellipsize(ctx: Ctx2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return `${s}…`;
}

function dim(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function arc(ctx: Ctx2D, radius: number, from: number, to: number, width: number, color: string) {
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'butt';
  ctx.arc(CX, CY, radius, from, to);
  ctx.stroke();
}

/** Small dots around the bezel showing which card of N you are on. */
function positionDots(
  ctx: Ctx2D,
  count: number,
  active: number,
  accent: string,
  radius = R - 6,
) {
  if (count <= 1) return;
  const spread = Math.min(TAU * 0.28, count * 0.09);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1) - 0.5;
    // Subtract: canvas angles grow clockwise from 3 o'clock, so adding would
    // put card 0 on the right and read backwards.
    const a = Math.PI / 2 - t * spread; // clustered at 6 o'clock
    ctx.beginPath();
    ctx.fillStyle = i === active ? accent : 'rgba(255,255,255,0.22)';
    ctx.arc(CX + Math.cos(a) * radius, CY + Math.sin(a) * radius, i === active ? 3 : 2, 0, TAU);
    ctx.fill();
  }
}

function frame(ctx: Ctx2D, bg: string) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, TAU);
  ctx.clip();
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SIZE, SIZE);
}

/* ------------------------------ decks ------------------------------ */

function deckSummary(ctx: Ctx2D, d: DevicePayload) {
  const { accent } = d.theme;

  // Bezel: progress through the calendar year. Always meaningful, and it gives
  // the contribution number a frame of reference.
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), 0, 1);
  const end = Date.UTC(now.getUTCFullYear() + 1, 0, 1);
  const frac = (Date.now() - start) / (end - start);
  arc(ctx, R - 8, 0, TAU, 3, 'rgba(255,255,255,0.07)');
  arc(ctx, R - 8, TOP, TOP + TAU * frac, 3, accent);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const hero = compact(d.p.contrib);
  const px = fitText(ctx, hero, widthAt(CY, 26), 62, 700);
  ctx.fillStyle = '#fff';
  ctx.fillText(hero, CX, CY + px * 0.34);

  font(ctx, 11, 600);
  ctx.fillStyle = dim(accent, 0.95);
  ctx.fillText('CONTRIBUTIONS', CX, CY + px * 0.34 + 18);

  // Name above, secondary stats below.
  font(ctx, 13, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  const name = d.p.name ?? d.p.login;
  ctx.fillText(ellipsize(ctx, name, widthAt(CY - 58)), CX, CY - 52);

  font(ctx, 12, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText(`★ ${d.p.stars}    ${d.p.followers} followers`, CX, CY + 74);
}

function statCell(ctx: Ctx2D, x: number, y: number, value: string, label: string, accent: string) {
  ctx.textAlign = 'center';
  font(ctx, 24, 700);
  ctx.fillStyle = '#fff';
  ctx.fillText(value, x, y);
  font(ctx, 9, 600);
  ctx.fillStyle = dim(accent, 0.8);
  ctx.fillText(label, x, y + 12);
}

function deckRepo(ctx: Ctx2D, d: DevicePayload, repo: PayloadRepo, idx: number) {
  const { accent } = d.theme;
  ctx.textAlign = 'center';

  // Title with language colour dot, nudged right to leave room for the dot.
  fitText(ctx, repo.n, widthAt(CY - 66) - 20, 17, 700);
  const w = ctx.measureText(repo.n).width;
  ctx.fillStyle = '#fff';
  ctx.fillText(repo.n, CX + 6, CY - 60);
  if (repo.col) {
    ctx.beginPath();
    ctx.fillStyle = repo.col;
    ctx.arc(CX - w / 2 - 3, CY - 65, 4, 0, TAU);
    ctx.fill();
  }

  statCell(ctx, CX - 40, CY - 12, compact(repo.s), 'STARS', accent);
  statCell(ctx, CX + 40, CY - 12, compact(repo.f), 'FORKS', accent);
  statCell(ctx, CX - 40, CY + 38, compact(repo.pr), 'OPEN PRS', accent);
  statCell(ctx, CX + 40, CY + 38, compact(repo.i), 'ISSUES', accent);

  ctx.beginPath();
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 1;
  ctx.moveTo(CX - 52, CY + 12);
  ctx.lineTo(CX + 52, CY + 12);
  ctx.stroke();

  font(ctx, 10, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText(ellipsize(ctx, ago(repo.c), widthAt(CY + 66)), CX, CY + 66);

  positionDots(ctx, d.repos.length, idx, accent);
}

/**
 * 52 weekly commit totals as radial bars -- one revolution is one year.
 * Normalised per repo: these repos peak between 18 and 228 commits a week, so a
 * shared scale would flatten three of the four to nothing.
 */
function deckSpark(ctx: Ctx2D, d: DevicePayload, repo: PayloadRepo, idx: number) {
  const { accent } = d.theme;
  const weeks = repo.w;
  const inner = R - 40;
  const outer = R - 8;

  ctx.textAlign = 'center';

  if (weeks.length === 0) {
    font(ctx, 13, 600);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText('no commit data yet', CX, CY + 4);
  } else {
    // Baseline ring, so a week with no commits reads as an empty slot rather
    // than as a rendering failure. These repos are bursty: typically only 3-8
    // of 52 weeks are non-zero.
    arc(ctx, inner, 0, TAU, 1, 'rgba(255,255,255,0.08)');

    const peak = Math.max(...weeks, 1);
    const step = TAU / weeks.length;
    weeks.forEach((v, i) => {
      const a = TOP + i * step;
      ctx.beginPath();
      if (v === 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.13)';
        ctx.lineWidth = 2;
        ctx.lineCap = 'butt';
        ctx.moveTo(CX + Math.cos(a) * inner, CY + Math.sin(a) * inner);
        ctx.lineTo(CX + Math.cos(a) * (inner + 2), CY + Math.sin(a) * (inner + 2));
      } else {
        const len = 4 + (outer - inner - 4) * (v / peak);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.moveTo(CX + Math.cos(a) * inner, CY + Math.sin(a) * inner);
        ctx.lineTo(CX + Math.cos(a) * (inner + len), CY + Math.sin(a) * (inner + len));
      }
      ctx.stroke();
    });

    font(ctx, 13, 700);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(`${peak}`, CX, CY + 28);
    font(ctx, 9, 600);
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.fillText('PEAK WEEK', CX, CY + 41);
    ctx.fillText('52 WEEKS', CX, CY + 56);
  }

  const px = fitText(ctx, repo.n, widthAt(CY) - 90, 18, 700);
  ctx.fillStyle = '#fff';
  ctx.fillText(repo.n, CX, CY + px * 0.35 - 10);

  // Inside the ring: the bars already own the bezel out to R-8.
  positionDots(ctx, d.repos.length, idx, accent, inner - 14);
}

function deckActivity(ctx: Ctx2D, d: DevicePayload) {
  const { accent } = d.theme;
  ctx.textAlign = 'center';
  font(ctx, 11, 700);
  ctx.fillStyle = dim(accent, 0.9);
  ctx.fillText('ACTIVITY', CX, CY - 78);

  if (d.ev.length === 0) {
    font(ctx, 13, 600);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText('all quiet', CX, CY + 4);
    return;
  }

  const rows = d.ev.slice(0, 4);
  const rowH = 30;
  const block = rows.length * rowH;
  const top = CY - block / 2 + 20;

  // One column width for every row, measured at the widest row's extreme. Using
  // widthAt() per row staggers the left edges and looks broken.
  const extreme = Math.max(Math.abs(top - rowH + 4 - CY), Math.abs(top + block - rowH - CY));
  const colW = Math.min(widthAt(CY + extreme, 12), 168);
  const left = CX - colW / 2;
  const right = CX + colW / 2;

  rows.forEach((e, i) => {
    const y = top + i * rowH;
    const short = e.r.includes('/') ? e.r.split('/')[1]! : e.r;
    const delta = e.d > 0 ? `+${e.d}` : e.d < 0 ? String(e.d) : '';
    const label = `${delta ? `${delta} ` : ''}${EVENT_LABEL[e.k] ?? e.k}`;

    ctx.textAlign = 'left';
    font(ctx, 13, 700);
    ctx.fillStyle = e.k === 'star' ? accent : '#fff';
    ctx.fillText(label, left, y);
    const labelW = ctx.measureText(label).width;

    font(ctx, 12, 500);
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.fillText(ellipsize(ctx, short, colW - labelW - 8), left + labelW + 8, y);

    ctx.textAlign = 'right';
    font(ctx, 10, 500);
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.fillText(ago(e.at), right, y + 13);
    ctx.textAlign = 'center';
  });
}

/* ------------------------------ entry point ------------------------------ */

export interface ViewState {
  deck: DeckId;
  index: number;
}

/** Number of cards in a deck, so the knob knows how far it can turn. */
export function deckLength(payload: DevicePayload, deck: DeckId): number {
  return deck === 'repos' || deck === 'spark' ? Math.max(1, payload.repos.length) : 1;
}

export function render(ctx: Ctx2D, payload: DevicePayload, view: ViewState) {
  frame(ctx, payload.theme.bg);
  const repo = payload.repos[Math.min(view.index, payload.repos.length - 1)];

  switch (view.deck) {
    case 'summary':
      deckSummary(ctx, payload);
      break;
    case 'repos':
      if (repo) deckRepo(ctx, payload, repo, view.index);
      break;
    case 'spark':
      if (repo) deckSpark(ctx, payload, repo, view.index);
      break;
    case 'activity':
      deckActivity(ctx, payload);
      break;
  }
  ctx.restore();
}
