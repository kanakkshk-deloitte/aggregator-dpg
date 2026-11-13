/**
 * Unit tests for BrandPanel.
 *
 * Covers: the hero-text fallback rendered while the aggregator config query
 * has no logo configured (the DEFAULT_AGGREGATOR_CONFIG shape), the
 * `withStraplineLight` image branch when the config supplies one, and that
 * the canvas particle animation effect mounts and tears down without
 * throwing (canvas 2D context + ResizeObserver are stubbed globally in
 * `src/__tests__/setup.ts`).
 *
 * To exercise the per-dot drawing branches (`hexToRgbaPrefix`/`applyAlpha`),
 * the canvas's `getBoundingClientRect` is stubbed to report a real size —
 * jsdom's default is 0x0, which short-circuits `buildDots()` before any
 * dots are created.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } = vi.hoisted(() => {
  const DEFAULT_AGGREGATOR_CONFIG = {
    aggregator: { name: 'Aggregator' },
    brand: {
      short_name: 'Blue Dots',
      long_name: 'Blue Dots Aggregator Portal',
      url_slug: 'dashboard',
      primary_color: '#2563EB',
    },
    network: { id: 'blue_dot' },
    domains: [],
  };
  return { useAggregatorConfig: vi.fn(), DEFAULT_AGGREGATOR_CONFIG };
});

vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig,
  DEFAULT_AGGREGATOR_CONFIG,
}));

vi.mock('next/image', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => <img {...props} alt={props.alt} />,
}));

import { BrandPanel } from '@/components/login/BrandPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('<BrandPanel />', () => {
  it('renders the short-name heading fallback when no logo is configured', () => {
    useAggregatorConfig.mockReturnValue({ data: undefined });
    const { getByText, queryByRole } = render(<BrandPanel />);
    expect(getByText('Blue Dots')).toBeInTheDocument();
    expect(queryByRole('img')).toBeNull();
  });

  it('renders the withStraplineLight logo image when configured', () => {
    useAggregatorConfig.mockReturnValue({
      data: {
        ...DEFAULT_AGGREGATOR_CONFIG,
        brand: {
          ...DEFAULT_AGGREGATOR_CONFIG.brand,
          short_name: 'Purple Dots',
          logo: { withStraplineLight: '/logo-strap.png' },
        },
      },
    });
    const { getByRole, queryByText } = render(<BrandPanel />);
    const img = getByRole('img');
    expect(img).toHaveAttribute('src', '/logo-strap.png');
    expect(img).toHaveAttribute('alt', 'Purple Dots');
    expect(queryByText('Purple Dots')).toBeNull();
  });

  it('derives the hero gradient from a custom primary/accent brand color', () => {
    useAggregatorConfig.mockReturnValue({
      data: {
        ...DEFAULT_AGGREGATOR_CONFIG,
        brand: {
          ...DEFAULT_AGGREGATOR_CONFIG.brand,
          primary_color: '#ff7a00',
          accent_color: '#00ff7a',
        },
      },
    });
    const { container } = render(<BrandPanel />);
    const hero = container.firstElementChild as HTMLElement;
    expect(hero.style.background).toContain('linear-gradient');
  });

  it('mounts and tears down the canvas particle animation without throwing', () => {
    useAggregatorConfig.mockReturnValue({ data: undefined });
    // Force a real, non-zero canvas size so buildDots() populates dots and
    // the per-dot draw path (hexToRgbaPrefix/applyAlpha) actually executes.
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
      width: 800,
      height: 600,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })) as unknown as typeof originalRect;

    const { unmount } = render(<BrandPanel />);
    expect(() => unmount()).not.toThrow();

    HTMLElement.prototype.getBoundingClientRect = originalRect;
  });
});
