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
function positionDots(ctx: Ctx2D, count: number, active: number, accent: string) {
  if (count <= 1) return;
  const radius = R - 6;
  const spread = Math.min(TAU * 0.28, count * 0.09);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1) - 0.5;
    const a = Math.PI / 2 + t * spread; // clustered at 6 o'clock
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

  // Title with language colour dot.
  const titlePx = fitText(ctx, repo.n, widthAt(CY - 66) - 16, 17, 700);
  const w = ctx.measureText(repo.n).width;
  ctx.fillStyle = '#fff';
  ctx.fillText(repo.n, CX + 6, CY - 60);
  if (repo.col) {
    ctx.beginPath();
    ctx.fillStyle = repo.col;
    ctx.arc(CX - w / 2 - 3, CY - 65, 4, 0, TAU);
    ctx.fill();
  }
  void titlePx;

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
  const inner = R - 46;
  const outer = R - 12;

  ctx.textAlign = 'center';

  if (weeks.length === 0) {
    font(ctx, 12, 600);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText('no commit data yet', CX, CY + 4);
  } else {
    const peak = Math.max(...weeks, 1);
    const step = TAU / weeks.length;
    weeks.forEach((v, i) => {
      const a = TOP + i * step;
      const len = v === 0 ? 1.5 : 3 + (outer - inner - 3) * (v / peak);
      ctx.beginPath();
      ctx.strokeStyle = v === 0 ? 'rgba(255,255,255,0.10)' : accent;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.moveTo(CX + Math.cos(a) * inner, CY + Math.sin(a) * inner);
      ctx.lineTo(CX + Math.cos(a) * (inner + len), CY + Math.sin(a) * (inner + len));
      ctx.stroke();
    });

    font(ctx, 10, 600);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(`peak ${peak}/wk`, CX, CY + 34);
    font(ctx, 9, 600);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillText('52 WEEKS', CX, CY + 50);
  }

  const px = fitText(ctx, repo.n, widthAt(CY) - 60, 16, 700);
  ctx.fillStyle = '#fff';
  ctx.fillText(repo.n, CX, CY + px * 0.35 - 6);

  positionDots(ctx, d.repos.length, idx, accent);
}

function deckActivity(ctx: Ctx2D, d: DevicePayload) {
  const { accent } = d.theme;
  ctx.textAlign = 'center';
  font(ctx, 11, 700);
  ctx.fillStyle = dim(accent, 0.9);
  ctx.fillText('ACTIVITY', CX, CY - 74);

  if (d.ev.length === 0) {
    font(ctx, 12, 600);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText('all quiet', CX, CY + 4);
    return;
  }

  const rows = d.ev.slice(0, 5);
  rows.forEach((e, i) => {
    const y = CY - 44 + i * 26;
    const max = widthAt(y) - 12;
    const short = e.r.includes('/') ? e.r.split('/')[1]! : e.r;
    const delta = e.d > 0 ? `+${e.d}` : e.d < 0 ? String(e.d) : '';

    font(ctx, 12, 700);
    ctx.fillStyle = '#fff';
    const label = `${delta ? `${delta} ` : ''}${EVENT_LABEL[e.k] ?? e.k}`;
    const nameMax = max - ctx.measureText(label).width - 10;

    ctx.textAlign = 'left';
    const left = CX - max / 2;
    ctx.fillStyle = e.k === 'star' ? accent : '#fff';
    ctx.fillText(label, left, y);

    font(ctx, 11, 500);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(ellipsize(ctx, short, Math.max(20, nameMax)), left + 46, y);

    font(ctx, 9, 500);
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.textAlign = 'right';
    ctx.fillText(ago(e.at), CX + max / 2, y + 11);
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
