/**
 * Unit tests for SearchableSelect: a dropdown that can also be searched.
 *
 * Covers: the placeholder and the chosen option on the button, the full list
 * on click, filtering by label and hint, the no-match text, picking by click
 * and by keyboard (arrows and Enter).
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SearchableSelect, type SearchableOption } from '@/components/ui/SearchableSelect';

const OPTIONS: SearchableOption[] = [
  { value: 'root', label: 'Blue Dots', hint: 'Top level' },
  { value: 'a', label: 'Edge Org A', hint: 'District' },
  { value: 'b', label: 'Edge Org B', hint: null },
  { value: 'c', label: 'SkillBridge', hint: 'Taluk' },
];

function renderIt(value = '', onValueChange = vi.fn()) {
  render(
    <SearchableSelect
      id="parent"
      options={OPTIONS}
      value={value}
      onValueChange={onValueChange}
      placeholder="Select a parent"
      searchPlaceholder="Type to search"
      emptyText="Nothing matches."
    />,
  );
  return onValueChange;
}

const open = () => fireEvent.click(screen.getByRole('button'));
const search = () => screen.getByRole('combobox', { name: 'Type to search' });
const optionNames = () => screen.getAllByRole('option').map((o) => o.textContent);

describe('<SearchableSelect />', () => {
  it('shows the placeholder when nothing is chosen', () => {
    renderIt();
    expect(screen.getByRole('button')).toHaveTextContent('Select a parent');
  });

  it('shows the chosen option with its hint on the button', () => {
    renderIt('a');
    expect(screen.getByRole('button')).toHaveTextContent('Edge Org A (District)');
  });

  it('opens the full list on click', () => {
    renderIt();
    open();
    expect(optionNames()).toEqual([
      'Blue DotsTop level',
      'Edge Org ADistrict',
      'Edge Org B',
      'SkillBridgeTaluk',
    ]);
  });

  it('narrows the list by name or hint as you type', () => {
    renderIt();
    open();
    fireEvent.change(search(), { target: { value: 'edge' } });
    expect(optionNames()).toEqual(['Edge Org ADistrict', 'Edge Org B']);
    fireEvent.change(search(), { target: { value: 'taluk' } });
    expect(optionNames()).toEqual(['SkillBridgeTaluk']);
  });

  it('says when nothing matches', () => {
    renderIt();
    open();
    fireEvent.change(search(), { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('Nothing matches.')).toBeInTheDocument();
  });

  it('picks an option by click', () => {
    const onValueChange = renderIt();
    open();
    fireEvent.click(screen.getByRole('option', { name: /Edge Org B/ }));
    expect(onValueChange).toHaveBeenCalledWith('b');
  });

  it('picks with the arrow keys and Enter', () => {
    const onValueChange = renderIt();
    open();
    fireEvent.change(search(), { target: { value: 'edge' } });
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(onValueChange).toHaveBeenCalledWith('b');
  });

  it('marks the chosen option as selected', () => {
    renderIt('c');
    open();
    expect(screen.getByRole('option', { name: /SkillBridge/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
