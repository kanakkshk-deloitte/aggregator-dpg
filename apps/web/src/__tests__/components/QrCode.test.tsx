import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { QrCode } from '@/components/ui/QrCode';

describe('<QrCode />', () => {
  it('renders an svg at the default size', () => {
    const { container } = render(<QrCode />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('width', '180');
    expect(svg).toHaveAttribute('height', '180');
  });

  it('renders an svg at a custom size', () => {
    const { container } = render(<QrCode size={240} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '240');
    expect(svg).toHaveAttribute('height', '240');
  });

  it('renders the BD center label and finder patterns', () => {
    const { container, getByText } = render(<QrCode />);
    expect(getByText('BD')).toBeInTheDocument();
    // Three finder-pattern groups (top-left, top-right, bottom-left).
    const rects = container.querySelectorAll('rect');
    expect(rects.length).toBeGreaterThan(10);
  });
});
