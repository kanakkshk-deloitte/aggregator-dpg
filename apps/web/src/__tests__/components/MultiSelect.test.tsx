import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/MultiSelect';

/** The popover trigger button — distinguished from per-chip "Remove X" buttons. */
function getTrigger(container: HTMLElement): HTMLElement {
  const el = container.querySelector('button[aria-haspopup="listbox"]');
  if (!el) throw new Error('MultiSelect trigger button not found');
  return el as HTMLElement;
}

const options: MultiSelectOption[] = [
  { value: 'js', label: 'JavaScript' },
  { value: 'py', label: 'Python' },
  { value: 'go', label: 'Go' },
];

beforeEach(() => {
  // Radix Popover positioning reads these during layout; jsdom lacks them.
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

describe('<MultiSelect />', () => {
  it('shows the placeholder when nothing is selected', () => {
    render(<MultiSelect options={options} value={[]} onChange={vi.fn()} placeholder="Pick some" />);
    expect(screen.getByText('Pick some')).toBeInTheDocument();
  });

  it('renders a chip per selected value with its label', () => {
    render(<MultiSelect options={options} value={['js', 'go']} onChange={vi.fn()} />);
    expect(screen.getByText('JavaScript')).toBeInTheDocument();
    expect(screen.getByText('Go')).toBeInTheDocument();
    expect(screen.queryByText('Python')).toBeNull();
  });

  it('falls back to the raw value as a label when no matching option exists', () => {
    render(<MultiSelect options={options} value={['rust']} onChange={vi.fn()} />);
    expect(screen.getByText('rust')).toBeInTheDocument();
  });

  it('opens the popover and adds an option on click', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <MultiSelect options={options} value={['js']} onChange={onChange} />,
    );
    fireEvent.click(getTrigger(container));
    // Exact match distinguishes the plain option button from a same-labelled
    // "Remove Python" chip button, which would otherwise also match a loose query.
    const pyOption = await screen.findByRole('button', { name: 'Python', exact: true });
    fireEvent.click(pyOption);
    expect(onChange).toHaveBeenCalledWith(['js', 'py']);
  });

  it('removes an option when clicked again while already selected', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <MultiSelect options={options} value={['js', 'py']} onChange={onChange} />,
    );
    fireEvent.click(getTrigger(container));
    const pyOption = await screen.findByRole('button', { name: 'Python', exact: true });
    fireEvent.click(pyOption);
    expect(onChange).toHaveBeenCalledWith(['js']);
  });

  it('removes a chip via its own remove button without opening the popover', () => {
    const onChange = vi.fn();
    render(<MultiSelect options={options} value={['js', 'py']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove JavaScript' }));
    expect(onChange).toHaveBeenCalledWith(['py']);
    // Popover should not have opened as a side effect of the chip click.
    expect(screen.queryByText('Go')).toBeNull();
  });

  it('shows a "No options." message when options is empty', () => {
    const { container } = render(<MultiSelect options={[]} value={[]} onChange={vi.fn()} />);
    fireEvent.click(getTrigger(container));
    expect(screen.getByText('No options.')).toBeInTheDocument();
  });

  it('disables the trigger button when disabled is set', () => {
    const { container } = render(
      <MultiSelect options={options} value={[]} onChange={vi.fn()} disabled />,
    );
    expect(getTrigger(container)).toBeDisabled();
  });
});
