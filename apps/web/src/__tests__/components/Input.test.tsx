import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { Input } from '@/components/ui/Input';

describe('<Input />', () => {
  it('renders an input element and accepts typed text', async () => {
    const user = userEvent.setup();
    render(<Input aria-label="username" />);
    const input = screen.getByLabelText('username') as HTMLInputElement;
    await user.type(input, 'hello');
    expect(input.value).toBe('hello');
  });

  it('merges a custom className with the base bd-input class', () => {
    render(<Input aria-label="x" className="extra" />);
    expect(screen.getByLabelText('x')).toHaveClass('bd-input');
    expect(screen.getByLabelText('x')).toHaveClass('extra');
  });

  it('forwards the ref to the underlying input element', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} aria-label="ref-input" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  it('forwards native attributes such as disabled and onChange', async () => {
    const onChange = vi.fn();
    render(<Input aria-label="disabled-input" disabled onChange={onChange} />);
    const input = screen.getByLabelText('disabled-input');
    expect(input).toBeDisabled();
  });
});
