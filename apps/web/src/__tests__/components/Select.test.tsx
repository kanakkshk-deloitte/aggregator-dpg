/**
 * Unit tests for the shadcn/ui Select wrapper (`components/ui/Select.tsx`).
 *
 * Rendered in the Radix-controlled `open` mode so the portal content mounts
 * deterministically in jsdom without needing to simulate the pointer-capture
 * based open interaction. Covers the sub-components not already exercised
 * indirectly via LanguageSwitcher/ConsentCheckboxWidget/RjsfThemed: grouped
 * items with a `SelectLabel`, and a `SelectSeparator` between groups.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';

beforeEach(() => {
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

function ControlledSelect({ onValueChange = vi.fn() }: { onValueChange?: (v: string) => void }) {
  return (
    <Select open value="a" onValueChange={onValueChange}>
      <SelectTrigger aria-label="Fruit">
        <SelectValue placeholder="Choose a fruit" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Citrus</SelectLabel>
          <SelectItem value="a">Orange</SelectItem>
          <SelectItem value="b">Lemon</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Stone fruit</SelectLabel>
          <SelectItem value="c">Peach</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

describe('<Select /> (shadcn wrapper)', () => {
  it('renders the trigger with the placeholder when closed and no value', () => {
    render(
      <Select>
        <SelectTrigger aria-label="Fruit">
          <SelectValue placeholder="Choose a fruit" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Orange</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(screen.getByText('Choose a fruit')).toBeInTheDocument();
  });

  it('renders group labels and items when open', () => {
    render(<ControlledSelect />);
    expect(screen.getByText('Citrus')).toBeInTheDocument();
    expect(screen.getByText('Stone fruit')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Orange' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Lemon' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Peach' })).toBeInTheDocument();
  });

  it('marks the current value as the checked option', () => {
    render(<ControlledSelect />);
    expect(screen.getByRole('option', { name: 'Orange' })).toHaveAttribute('data-state', 'checked');
    expect(screen.getByRole('option', { name: 'Lemon' })).toHaveAttribute(
      'data-state',
      'unchecked',
    );
  });

  it('fires onValueChange when a different item is selected', () => {
    const onValueChange = vi.fn();
    render(<ControlledSelect onValueChange={onValueChange} />);
    fireEvent.click(screen.getByRole('option', { name: 'Lemon' }));
    expect(onValueChange).toHaveBeenCalledWith('b');
  });

  it('applies the disabled state to the trigger', () => {
    render(
      <Select disabled>
        <SelectTrigger aria-label="Fruit">
          <SelectValue placeholder="Choose a fruit" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Orange</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(screen.getByLabelText('Fruit')).toBeDisabled();
  });
});
