import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/services/http', () => ({
  jsonFetch: vi.fn().mockResolvedValue({
    aggregator: { name: 'Aggregator' },
    brand: { short_name: 'Blue Dots', long_name: 'Blue Dots Aggregator Portal', url_slug: 'x' },
    network: { id: 'blue_dot' },
    domains: [],
  }),
}));

const { Providers } = await import('@/lib/providers');

describe('Providers', () => {
  it('renders children wrapped in the query/theme provider tree', () => {
    render(
      <Providers>
        <span>hello</span>
      </Providers>,
    );
    expect(screen.getByText('hello')).toBeInTheDocument();
  });
});
