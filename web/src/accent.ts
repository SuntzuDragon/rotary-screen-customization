/**
 * Make the site wear whatever accent the dial is set to.
 *
 * The colour is free-form -- it comes out of a native colour picker -- so the
 * palette cannot assume anything about it. Two things break if the raw value
 * is used everywhere:
 *
 *   - white label text on the primary button disappears against a pale accent;
 *   - link text in the accent disappears against the dark panel when the
 *     accent is itself dark.
 *
 * So the raw colour is used for fills, and two derived tokens carry the text
 * cases: `--accent-ink` (what sits *on* the accent) and `--accent-text` (the
 * accent lightened until it is legible on the page).
 */

import { DEFAULT_ACCENT } from './types';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

const toHex = ({ r, g, b }: Rgb) =>
  `#${[r, g, b].map((v) => Math.round(clamp01(v / 255) * 255).toString(16).padStart(2, '0')).join('')}`;

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** Mix toward white by `amount` (0..1). */
const lighten = (c: Rgb, amount: number): Rgb => ({
  r: c.r + (255 - c.r) * amount,
  g: c.g + (255 - c.g) * amount,
  b: c.b + (255 - c.b) * amount,
});

/**
 * Lighten until the colour is readable on the panel, giving up at white.
 *
 * 4.5:1 is the WCAG AA threshold for body text. Links are the only accent-
 * coloured text on the page, and a dark red on a near-black panel is otherwise
 * genuinely unreadable rather than merely subtle.
 */
function readableOn(colour: Rgb, background: Rgb, target = 4.5): Rgb {
  if (contrast(colour, background) >= target) return colour;
  for (let step = 1; step <= 20; step++) {
    const next = lighten(colour, step / 20);
    if (contrast(next, background) >= target) return next;
  }
  return { r: 255, g: 255, b: 255 };
}

const PANEL: Rgb = { r: 0x14, g: 0x18, b: 0x1d };
const INK_DARK = '#0b0d10';

/**
 * Paint `hex` onto the document. Anything unparseable falls back to the
 * default rather than leaving the page half-themed.
 */
export function applyAccent(hex: string) {
  const rgb = parseHex(hex) ?? parseHex(DEFAULT_ACCENT)!;
  const root = document.documentElement.style;

  root.setProperty('--accent', toHex(rgb));
  // Dark text over a light accent, white over a dark one.
  //
  // Maximum contrast would flip at luminance 0.179, which would put black text
  // on the default orange -- more readable on paper (5.98:1 against white's
  // 3.51:1) but not the look this site has. So the bias is toward white, and
  // it flips only once white genuinely fails: white drops under 3:1 above
  // luminance 0.3, which is the threshold here.
  root.setProperty('--accent-ink', luminance(rgb) > 0.3 ? INK_DARK : '#ffffff');
  root.setProperty('--accent-text', toHex(readableOn(rgb, PANEL)));
  // The flashing warning is deliberately NOT themed. Its wash used to be an
  // orange that happened to match the accent; tinting it with the chosen
  // colour turned a warning green, which reads as reassurance.
}

/** Back to the colour a device ships with. */
export const resetAccent = () => applyAccent(DEFAULT_ACCENT);
