/**
 * Hex-colour helpers shared by the brand theming code.
 *
 * Used by `theme-provider.tsx` and `components/login/BrandPanel.tsx` to parse
 * and blend `#rrggbb` brand colours.
 *
 * @module apps/web/src/lib/hex-color
 */

/** An `#rrggbb` colour decomposed into 0-255 red, green and blue channels. */
export type Rgb = [number, number, number];

/**
 * Parses an `#rrggbb` colour, with or without the leading `#`.
 *
 * @param value - The candidate colour string; surrounding whitespace is ignored.
 * @returns The channel triple, or `null` when the value is not six hex digits.
 */
export function parseHex(value: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const hex = m[1]!;
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

/**
 * Mixes two hex colours, `weight` of the way from `a` toward `b`.
 *
 * `weight=0` returns `a` and `weight=1` returns `b`.
 *
 * @param a - The base colour, `#rrggbb` with or without the `#`.
 * @param b - The colour to mix toward, in the same form.
 * @param weight - How far to travel from `a` to `b`, clamped to 0..1.
 * @returns The blended `#rrggbb` colour, or `a` unchanged if either input is malformed.
 */
export function mix(a: string, b: string, weight: number): string {
  const A = parseHex(a);
  const B = parseHex(b);
  if (!A || !B) return a;
  const w = Math.max(0, Math.min(1, weight));
  const r = Math.round(A[0] * (1 - w) + B[0] * w);
  const g = Math.round(A[1] * (1 - w) + B[1] * w);
  const bl = Math.round(A[2] * (1 - w) + B[2] * w);
  return '#' + [r, g, bl].map((n) => n.toString(16).padStart(2, '0')).join('');
}
