import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { ThemeProvider } from '@/lib/theme-provider';
import type { AggregatorConfigPayload } from '@/hooks/useAggregatorConfig';

const useAggregatorConfigMock = vi.fn();
vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => useAggregatorConfigMock(),
}));

function root() {
  return document.documentElement;
}

describe('ThemeProvider', () => {
  afterEach(() => {
    for (const prop of Array.from(root().style)) {
      root().style.removeProperty(prop);
    }
    useAggregatorConfigMock.mockReset();
  });

  it('renders children without touching CSS vars while config is loading', () => {
    useAggregatorConfigMock.mockReturnValue({ data: undefined });
    render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );
    expect(root().style.getPropertyValue('--bd-primary')).toBe('');
  });

  it('writes the primary ramp + brand var from primary/accent colors', () => {
    useAggregatorConfigMock.mockReturnValue({
      data: {
        brand: { primary_color: '#2563eb', accent_color: '#16a34a' },
      } as Partial<AggregatorConfigPayload>,
    });
    render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );
    expect(root().style.getPropertyValue('--bd-primary')).toBe('#2563eb');
    expect(root().style.getPropertyValue('--bd-brand')).toBe('#16a34a');
    expect(root().style.getPropertyValue('--bd-primary-500')).toBe('#16a34a');
    expect(root().style.getPropertyValue('--bd-primary-600')).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('falls back accent to primary when accent is absent', () => {
    useAggregatorConfigMock.mockReturnValue({
      data: { brand: { primary_color: '#2563eb' } } as Partial<AggregatorConfigPayload>,
    });
    render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );
    expect(root().style.getPropertyValue('--bd-brand')).toBe('#2563eb');
  });

  it('writes palette swatches + gradients when a palette is present', () => {
    useAggregatorConfigMock.mockReturnValue({
      data: {
        brand: {
          primary_color: '#2563eb',
          palette: {
            secondary: [{ name: 'Sky Blue', hex: '#0ea5e9' }],
            accent: [{ name: 'Coral', hex: '#ff6f61' }],
            gradients: [{ name: 'Sunrise', from: '#ffedd5', to: '#fca5a5' }],
          },
        },
      } as Partial<AggregatorConfigPayload>,
    });
    render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );
    expect(root().style.getPropertyValue('--bd-secondary-1')).toBe('#0ea5e9');
    expect(root().style.getPropertyValue('--bd-secondary-sky-blue')).toBe('#0ea5e9');
    expect(root().style.getPropertyValue('--bd-accent-1')).toBe('#ff6f61');
    expect(root().style.getPropertyValue('--bd-gradient-sunrise')).toBe(
      'linear-gradient(135deg, #ffedd5, #fca5a5)',
    );
  });

  it('writes typography font vars when typography is present', () => {
    useAggregatorConfigMock.mockReturnValue({
      data: {
        brand: {
          primary_color: '#2563eb',
          typography: {
            primaryFont: 'Inter',
            headings: { family: 'Poppins', weight: '700' },
            body: { family: 'Inter', weight: '400' },
          },
        },
      } as Partial<AggregatorConfigPayload>,
    });
    render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );
    expect(root().style.getPropertyValue('--bd-font-sans')).toBe('Inter');
    expect(root().style.getPropertyValue('--bd-font-heading')).toBe('Poppins');
    expect(root().style.getPropertyValue('--bd-font-body')).toBe('Inter');
  });

  it('falls through to the base color for a malformed hex during mix', () => {
    useAggregatorConfigMock.mockReturnValue({
      data: { brand: { primary_color: 'not-a-color' } } as Partial<AggregatorConfigPayload>,
    });
    render(
      <ThemeProvider>
        <span>child</span>
      </ThemeProvider>,
    );
    expect(root().style.getPropertyValue('--bd-primary')).toBe('not-a-color');
    expect(root().style.getPropertyValue('--bd-primary-600')).toBe('not-a-color');
  });
});
