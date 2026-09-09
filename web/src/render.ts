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
export function widthAt(y: number, pad = 4): number {
  const dy = Math.abs(y - CY);
  if (dy >= R) return 0;
  return 2 * Math.sqrt(R * R - dy * dy) - pad * 2;
}

// The dots are the one constant across every screen, so they own a reserved
// band at the bezel and nothing else may enter it.
const DOTS_R = R - 9;
const CONTENT_R = DOTS_R - 14;

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

/**
 * Position indicator near 6 o'clock, mirroring the firmware.
 *
 * Sections are separated by a gap and section heads drawn larger, so the shape
 * of the list is readable rather than N anonymous dots. The radius never
 * changes between cards -- the dots must not appear to move as you scroll.
 */
function positionDots(ctx: Ctx2D, cards: Card[], cursor: number, accent: string) {
  if (cards.length <= 1) return;
  const GAP = 1.15;

  const offset: number[] = [];
  let run = 0;
  cards.forEach((c, i) => {
    if (i > 0) run += c.deck !== cards[i - 1]!.deck ? 1 + GAP : 1;
    offset.push(run);
  });
  const span = run || 1;
  const spread = Math.min(TAU * 0.34, span * 0.085);
  const radius = DOTS_R;

  cards.forEach((c, i) => {
    const t = offset[i]! / span - 0.5;
    const a = Math.PI / 2 - t * spread;
    const head = i === 0 || c.deck !== cards[i - 1]!.deck;
    const active = i === cursor;
    ctx.beginPath();
    ctx.fillStyle = active ? accent : head ? '#5C6672' : '#333B45';
    ctx.arc(CX + Math.cos(a) * radius, CY + Math.sin(a) * radius,
            active ? 3.5 : head ? 2.5 : 1.5, 0, TAU);
    ctx.fill();
  });
}

/** Five-point star, matching the glyph tools/gen_star.py rasterises for LVGL. */
function drawStar(ctx: Ctx2D, cx: number, cy: number, outer: number, color: string) {
  const inner = outer * 0.42;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? outer : inner;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
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
  arc(ctx, CONTENT_R, 0, TAU, 3, 'rgba(255,255,255,0.07)');
  arc(ctx, CONTENT_R, TOP, TOP + TAU * frac, 3, accent);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const hero = compact(d.p.contrib);
  const px = fitText(ctx, hero, widthAt(CY, 14), 62, 700);
  const heroBaseline = CY + px * 0.30;
  ctx.fillStyle = '#fff';
  ctx.fillText(hero, CX, heroBaseline);

  // Sits clear of the hero's baseline rather than at a fixed offset, so it
  // cannot collide when a larger contribution count shrinks the number.
  font(ctx, 12, 700);
  ctx.fillStyle = dim(accent, 0.95);
  ctx.fillText('CONTRIBUTIONS', CX, heroBaseline + 15);

  font(ctx, 16, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  const name = d.p.name ?? d.p.login;
  ctx.fillText(ellipsize(ctx, name, widthAt(CY - 60)), CX, CY - 50);

  // Star + count, mirroring the generated glyph the firmware draws.
  font(ctx, 20, 700);
  const countText = String(d.p.stars);
  const countW = ctx.measureText(countText).width;
  const starR = 8;
  const groupW = starR * 2 + 5 + countW;
  const left = CX - groupW / 2;
  drawStar(ctx, left + starR, CY + 61, starR, accent);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.fillText(countText, left + starR * 2 + 5, CY + 68);
  ctx.textAlign = 'center';

  font(ctx, 12, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText(`${d.p.followers} FOLLOWERS`, CX, CY + 88);
}

function statCell(ctx: Ctx2D, x: number, y: number, value: string, label: string, accent: string) {
  ctx.textAlign = 'center';
  font(ctx, 28, 700);
  ctx.fillStyle = '#fff';
  ctx.fillText(value, x, y);
  font(ctx, 11, 600);
  ctx.fillStyle = dim(accent, 0.85);
  ctx.fillText(label, x, y + 15);
}

function deckRepo(ctx: Ctx2D, d: DevicePayload, repo: PayloadRepo, idx: number) {
  const { accent } = d.theme;
  ctx.textAlign = 'center';

  // Title with language colour dot, nudged right to leave room for the dot.
  // Dot and title as one centred group, measured off the real text width so the
  // dot can never land outside the circle.
  fitText(ctx, repo.n, 150, 20, 700);
  const textW = ctx.measureText(repo.n).width;
  const dotD = repo.col ? 8 + 6 : 0;
  const groupLeft = CX - (textW + dotD) / 2;
  if (repo.col) {
    ctx.beginPath();
    ctx.fillStyle = repo.col;
    ctx.arc(groupLeft + 4, CY - 72 - 6, 4, 0, TAU);
    ctx.fill();
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.fillText(repo.n, groupLeft + dotD, CY - 66);
  ctx.textAlign = 'center';

  statCell(ctx, CX - 46, CY - 14, compact(repo.s), 'STARS', accent);
  statCell(ctx, CX + 46, CY - 14, compact(repo.f), 'FORKS', accent);
  statCell(ctx, CX - 46, CY + 42, compact(repo.pr), 'OPEN PRS', accent);
  statCell(ctx, CX + 46, CY + 42, compact(repo.i), 'ISSUES', accent);

  ctx.beginPath();
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = 1;
  ctx.moveTo(CX - 58, CY + 14);
  ctx.lineTo(CX + 58, CY + 14);
  ctx.stroke();

  font(ctx, 12, 600);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText(ellipsize(ctx, ago(repo.c), widthAt(CY + 76)), CX, CY + 78);

  void idx;
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

export interface Card {
  deck: DeckId;
  index: number;
}

/**
 * Flatten the enabled decks into the single list the knob scrolls, exactly as
 * the firmware does. Touch is not part of the input model: everything must be
 * reachable by turning alone.
 */
export function buildCards(payload: DevicePayload): Card[] {
  const cards: Card[] = [];
  const on = (d: DeckId) => payload.decks.includes(d);
  if (on('summary')) cards.push({ deck: 'summary', index: 0 });
  if (on('repos')) payload.repos.forEach((_, i) => cards.push({ deck: 'repos', index: i }));
  if (on('activity')) cards.push({ deck: 'activity', index: 0 });
  if (cards.length === 0) cards.push({ deck: 'summary', index: 0 });
  return cards;
}

/** Index of the first card of the next section, for the knob press. */
export function nextSection(cards: Card[], cursor: number): number {
  const cur = cards[cursor]?.deck;
  for (let step = 1; step <= cards.length; step++) {
    const i = (cursor + step) % cards.length;
    if (cards[i]!.deck !== cur) return i;
  }
  return cursor;
}

export function render(ctx: Ctx2D, payload: DevicePayload, cards: Card[], cursor: number) {
  frame(ctx, payload.theme.bg);
  const card = cards[Math.min(cursor, cards.length - 1)] ?? { deck: 'summary', index: 0 };
  const repo = payload.repos[card.index];

  switch (card.deck) {
    case 'summary':
      deckSummary(ctx, payload);
      break;
    case 'repos':
      if (repo) deckRepo(ctx, payload, repo, card.index);
      break;
    case 'activity':
      deckActivity(ctx, payload);
      break;
  }
  positionDots(ctx, cards, cursor, payload.theme.accent);
  ctx.restore();
}
