import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Label } from '@/components/ui/Label';

describe('<Label />', () => {
  it('renders children text', () => {
    render(<Label htmlFor="field">My Field</Label>);
    expect(screen.getByText('My Field')).toBeInTheDocument();
  });

  it('associates with a form control via htmlFor', () => {
    render(
      <>
        <Label htmlFor="the-input">Name</Label>
        <input id="the-input" />
      </>,
    );
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('merges a custom className', () => {
    render(<Label className="extra">Text</Label>);
    expect(screen.getByText('Text')).toHaveClass('extra');
    expect(screen.getByText('Text')).toHaveClass('bd-label');
  });
});
