'use client';

import { useEffect, type ReactNode } from 'react';
import { useAggregatorConfig } from '../hooks/useAggregatorConfig';
import { mix } from './hex-color';

/**
 * Writes the brand colours and fonts from the aggregator config onto `:root`
 * as CSS variables, which Tailwind utilities and components use.
 *
 * - `--bd-primary*` and `--bd-brand` are always set, derived from
 *   `primary_color` and `accent_color`.
 * - `--bd-secondary-*`, `--bd-accent-*`, `--bd-gradient-*` and `--bd-font-*`
 *   are set when `brand.json` provides `palette` / `typography`.
 *
 * @param children - The app subtree.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { data: cfg } = useAggregatorConfig();
  const primary = cfg?.brand.primary_color;
  const accent = cfg?.brand.accent_color;
  const palette = cfg?.brand.palette;
  const typography = cfg?.brand.typography;

  useEffect(() => {
    if (typeof document === 'undefined' || !primary) return;
    const root = document.documentElement;
    const accentHex = accent ?? primary;
    root.style.setProperty('--bd-primary', primary);
    root.style.setProperty('--bd-primary-600', mix(primary, '#000000', 0.15));
    root.style.setProperty('--bd-primary-500', accentHex);
    // Brand colour for success-coded surfaces: the accent, else the primary.
    root.style.setProperty('--bd-brand', accentHex);
  }, [primary, accent]);

  useEffect(() => {
    if (typeof document === 'undefined' || !palette) return;
    const root = document.documentElement;
    const writeSwatches = (
      group: 'secondary' | 'accent',
      swatches: { name: string; hex: string }[] | undefined,
    ) => {
      if (!swatches) return;
      swatches.forEach((s, idx) => {
        root.style.setProperty(`--bd-${group}-${idx + 1}`, s.hex);
        root.style.setProperty(`--bd-${group}-${slug(s.name)}`, s.hex);
      });
    };
    writeSwatches('secondary', palette.secondary);
    writeSwatches('accent', palette.accent);
    palette.gradients?.forEach((g) => {
      root.style.setProperty(
        `--bd-gradient-${slug(g.name)}`,
        `linear-gradient(135deg, ${g.from}, ${g.to})`,
      );
    });
  }, [palette]);

  useEffect(() => {
    if (typeof document === 'undefined' || !typography) return;
    const root = document.documentElement;
    root.style.setProperty('--bd-font-sans', typography.primaryFont);
    if (typography.headings?.family) {
      root.style.setProperty('--bd-font-heading', typography.headings.family);
    }
    if (typography.body?.family) {
      root.style.setProperty('--bd-font-body', typography.body.family);
    }
  }, [typography]);

  return <>{children}</>;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
