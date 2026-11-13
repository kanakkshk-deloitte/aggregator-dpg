/**
 * Unit tests for the shared icon map (`src/icons/index.tsx`).
 *
 * The module exports one small SVG-wrapping component per icon name under
 * `I`. Rather than one bespoke test per icon (there are ~35), this asserts
 * the shared rendering contract (default/custom size, default/custom
 * stroke, className passthrough) on a couple of representative icons, then
 * loops over every exported icon to prove each one renders a well-formed
 * `<svg>` without throwing — catching typos in any individual icon's path
 * data or a broken entry in the `I` map.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { I, type IconName } from '@/icons';

describe('icons', () => {
  it('renders every exported icon as a valid, non-empty svg', () => {
    const names = Object.keys(I) as IconName[];
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      const Icon = I[name];
      const { container, unmount } = render(<Icon />);
      const svg = container.querySelector('svg');
      expect(svg, `icon "${name}" did not render an <svg>`).toBeTruthy();
      expect(svg!.children.length, `icon "${name}" has no path/shape children`).toBeGreaterThan(0);
      unmount();
    }
  });

  it('applies the default size (18) and stroke width (1.7) when unset', () => {
    const { container } = render(<I.users />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '18');
    expect(svg).toHaveAttribute('height', '18');
    expect(svg).toHaveAttribute('stroke-width', '1.7');
  });

  it('honours a custom size and stroke width', () => {
    const { container } = render(<I.users size={32} stroke={3} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '32');
    expect(svg).toHaveAttribute('height', '32');
    expect(svg).toHaveAttribute('stroke-width', '3');
  });

  it('forwards a custom className to the svg element', () => {
    const { container } = render(<I.user className="text-primary-600" />);
    expect(container.querySelector('svg')).toHaveClass('text-primary-600');
  });

  it('renders using currentColor stroke and no fill, so it inherits text color', () => {
    const { container } = render(<I.check />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('fill', 'none');
  });

  it('overrides the shared default stroke width for icons with a fixed stroke (e.g. check)', () => {
    const { container } = render(<I.check />);
    expect(container.querySelector('svg')).toHaveAttribute('stroke-width', '2.4');
  });

  it('forwards arbitrary extra svg attributes (e.g. aria-hidden)', () => {
    const { container } = render(<I.bell aria-hidden="true" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
