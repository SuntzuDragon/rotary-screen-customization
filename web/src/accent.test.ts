import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyAccent } from './accent';

// applyAccent only ever writes CSS custom properties onto the root element, so
// a stand-in document that records them is enough to test it outside a browser.
let props: Record<string, string>;

beforeEach(() => {
  props = {};
  (globalThis as { document?: unknown }).document = {
    documentElement: { style: { setProperty: (k: string, v: string) => void (props[k] = v) } },
  };
});

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

// WCAG contrast, computed independently of the implementation.
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((n >> 16) & 0xff) + 0.7152 * ch((n >> 8) & 0xff) + 0.0722 * ch(n & 0xff);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const PANEL = '#14181d'; // the page's panel colour, which accent text sits on

describe('applyAccent', () => {
  it('uses the colour as given for fills', () => {
    applyAccent('#F74C00');
    expect(props['--accent']).toBe('#f74c00');
  });

  // The default orange would technically read better with dark text, but the
  // site keeps white on it by design; ink only flips once white truly fails.
  it('keeps white text on the default orange', () => {
    applyAccent('#F74C00');
    expect(props['--accent-ink']).toBe('#ffffff');
  });

  it('switches to dark text on a pale accent, where white would vanish', () => {
    applyAccent('#FFE680');
    expect(props['--accent-ink']).toBe('#0b0d10');
  });

  it.each(['#330000', '#001a33', '#1f1f1f', '#F74C00', '#FFE680'])(
    'makes accent text in %s readable on the panel (WCAG AA, 4.5:1)',
    (hex) => {
      applyAccent(hex);
      expect(contrast(props['--accent-text']!, PANEL)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('leaves an accent that is already readable unchanged', () => {
    applyAccent('#FFE680');
    expect(props['--accent-text']).toBe('#ffe680');
  });

  it('falls back to the default rather than half-theming the page', () => {
    applyAccent('not a colour');
    expect(props['--accent']).toBe('#f74c00');
  });
});
