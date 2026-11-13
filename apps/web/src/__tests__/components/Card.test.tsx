import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card } from '@/components/ui/Card';

describe('<Card />', () => {
  it('renders children', () => {
    render(<Card>hello card</Card>);
    expect(screen.getByText('hello card')).toBeInTheDocument();
  });

  it('applies the sm shadow class by default', () => {
    const { container } = render(<Card>content</Card>);
    const div = container.firstElementChild as HTMLElement;
    expect(div).toHaveClass('bd-card');
    expect(div).toHaveClass('bd-shadow');
  });

  it('applies the lg shadow class when requested', () => {
    const { container } = render(<Card shadow="lg">content</Card>);
    const div = container.firstElementChild as HTMLElement;
    expect(div).toHaveClass('bd-shadow-lg');
    expect(div).not.toHaveClass('bd-shadow');
  });

  it('applies no shadow class when shadow is "none"', () => {
    const { container } = render(<Card shadow="none">content</Card>);
    const div = container.firstElementChild as HTMLElement;
    expect(div).not.toHaveClass('bd-shadow');
    expect(div).not.toHaveClass('bd-shadow-lg');
  });

  it('merges a custom className and forwards other attributes', () => {
    render(
      <Card className="extra-class" data-testid="my-card">
        content
      </Card>,
    );
    const div = screen.getByTestId('my-card');
    expect(div).toHaveClass('extra-class');
    expect(div).toHaveClass('bd-card');
  });
});
