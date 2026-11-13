import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Avatar } from '@/components/ui/Avatar';

describe('<Avatar />', () => {
  it('renders the initials text', () => {
    render(<Avatar initials="AB" />);
    expect(screen.getByText('AB')).toBeInTheDocument();
  });

  it('applies a default size of 36px', () => {
    render(<Avatar initials="AB" />);
    const el = screen.getByText('AB');
    expect(el).toHaveStyle({ width: '36px', height: '36px' });
  });

  it('applies a custom size', () => {
    render(<Avatar initials="AB" size={64} />);
    const el = screen.getByText('AB');
    expect(el).toHaveStyle({ width: '64px', height: '64px' });
  });

  it('uses the explicit color when provided', () => {
    render(<Avatar initials="AB" color="#123456" />);
    expect(screen.getByText('AB')).toHaveStyle({ background: '#123456' });
  });

  it('derives a palette color deterministically from the initials when no color given', () => {
    const { container: c1 } = render(<Avatar initials="AB" />);
    const { container: c2 } = render(<Avatar initials="AB" />);
    const bg1 = (c1.firstElementChild as HTMLElement).style.background;
    const bg2 = (c2.firstElementChild as HTMLElement).style.background;
    expect(bg1).toBe(bg2);
    expect(bg1).toMatch(/^rgb/);
  });

  it('handles a single-character initials string without throwing', () => {
    render(<Avatar initials="A" />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });
});
