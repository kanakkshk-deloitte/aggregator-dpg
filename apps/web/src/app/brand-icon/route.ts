/**
 * Dynamic favicon route that tints the network-mark SVG with the brand colour.
 *
 * Reads `primary_color` from the api's `/v1/aggregator-config`. The response
 * is cached for five minutes.
 */

import { NextResponse } from 'next/server';

const FALLBACK_PRIMARY = '#2563EB';
const FALLBACK_PRIMARY_DARK = '#1D4ED8';

function deriveDark(hex: string): string {
  // Darken by ~12%, matching the ThemeProvider's `--bd-primary-600`.
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return FALLBACK_PRIMARY_DARK;
  const num = Number.parseInt(m[1]!, 16);
  const r = Math.round(((num >> 16) & 0xff) * 0.88);
  const g = Math.round(((num >> 8) & 0xff) * 0.88);
  const b = Math.round((num & 0xff) * 0.88);
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function rgbaTriple(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '37,99,235';
  const num = Number.parseInt(m[1]!, 16);
  return `${(num >> 16) & 0xff},${(num >> 8) & 0xff},${num & 0xff}`;
}

interface BrandShape {
  primary_color?: string;
}

async function loadPrimary(): Promise<string> {
  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
  try {
    const res = await fetch(`${apiBase}/v1/aggregator-config`, {
      // Re-fetch every 5 minutes.
      next: { revalidate: 300 },
    });
    if (!res.ok) return FALLBACK_PRIMARY;
    const body = (await res.json()) as { brand?: BrandShape };
    return body?.brand?.primary_color ?? FALLBACK_PRIMARY;
  } catch {
    return FALLBACK_PRIMARY;
  }
}

export async function GET() {
  const primary = await loadPrimary();
  const primaryDark = deriveDark(primary);
  const primaryRgb = rgbaTriple(primary);
  // Brand-mark dot: concentric rings around a filled centre.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="10" fill="#ffffff"/>
  <circle cx="24" cy="24" r="22" fill="none" stroke="rgba(${primaryRgb},0.18)" stroke-width="1.2"/>
  <circle cx="24" cy="24" r="17" fill="none" stroke="rgba(${primaryRgb},0.32)" stroke-width="1.4"/>
  <circle cx="24" cy="24" r="12" fill="none" stroke="rgba(${primaryRgb},0.55)" stroke-width="1.6"/>
  <circle cx="24" cy="24" r="8" fill="${primary}"/>
  <circle cx="24" cy="24" r="3" fill="${primaryDark}"/>
</svg>`;
  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}
