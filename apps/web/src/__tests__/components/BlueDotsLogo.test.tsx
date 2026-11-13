import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { BlueDotsLogo } from '@/components/ui/BlueDotsLogo';

describe('<BlueDotsLogo />', () => {
  it('renders an svg with the default size', () => {
    const { container } = render(<BlueDotsLogo />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('width', '44');
    expect(svg).toHaveAttribute('height', '44');
  });

  it('renders at a custom size', () => {
    const { container } = render(<BlueDotsLogo size={100} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '100');
    expect(svg).toHaveAttribute('height', '100');
  });

  it('renders the light-mode palette by default', () => {
    const { container } = render(<BlueDotsLogo />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg.style.background).toContain('EFF4FF');
  });

  it('renders the dark-mode palette when dark is true', () => {
    const { container } = render(<BlueDotsLogo dark />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg.style.background).toBe('rgb(11, 26, 58)');
  });
});
