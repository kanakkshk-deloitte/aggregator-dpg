/**
 * Keyboard navigation of the autocomplete suggestion lists.
 *
 * Driven through a real widget rather than the hook in isolation, because what
 * this guards is the wiring — handler attached, roles present,
 * `aria-activedescendant` pointing at a real option — not the index arithmetic.
 * Without it a keyboard or screen-reader user can type a query, watch
 * suggestions appear, and have no way to reach them.
 *
 * Two behaviours here are deliberate choices rather than conventions, and both
 * are asserted: the highlight CLAMPS at each end rather than wrapping (wrapping
 * hides the fact you have seen everything), and Enter is only swallowed when it
 * actually commits a suggestion, so it still submits the form otherwise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import type { GeoSuggestion } from '@/lib/geo/types';

const SUGGESTIONS: GeoSuggestion[] = [
  { label: 'Bengaluru, Karnataka', lat: 12.97, lng: 77.59 },
  { label: 'Bengaluru Rural, Karnataka', lat: 13.2, lng: 77.7 },
  { label: 'Bengaluru Urban, Karnataka', lat: 12.9, lng: 77.6 },
];

const suggestMock = vi.fn<(query: string, signal?: AbortSignal) => Promise<GeoSuggestion[]>>();

vi.mock('@/lib/geo/provider', () => ({
  getGeoProvider: () => ({ suggest: suggestMock }),
}));

import { LocationAutocompleteWidget } from '@/components/forms/custom-widgets/LocationAutocompleteWidget';

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

/** Renders the widget, types a query, and settles the list open. */
async function openList() {
  const onChange = vi.fn();
  render(
    <Wrapper>
      <LocationAutocompleteWidget
        {...({
          id: 'root_location',
          value: '',
          required: true,
          disabled: false,
          readonly: false,
          onChange,
          label: 'Location',
          schema: {},
          options: { isPrimaryLocation: true },
          uiSchema: {},
          registry: { formContext: {} },
          rawErrors: [],
        } as never)}
      />
    </Wrapper>,
  );
  const input = screen.getByRole('combobox');
  fireEvent.change(input, { target: { value: 'bengaluru' } });
  await vi.advanceTimersByTimeAsync(300);
  await screen.findByRole('listbox');
  // Let the hook's reset-on-new-results effect settle before any key is sent.
  await vi.advanceTimersByTimeAsync(0);
  return { input, onChange };
}

/** The label of the currently highlighted option, or undefined if none is. */
function activeLabel(): string | undefined {
  const id = screen.getByRole('combobox').getAttribute('aria-activedescendant');
  return id ? (document.getElementById(id)?.textContent ?? undefined) : undefined;
}

describe('suggestion-list keyboard navigation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    suggestMock.mockReset();
    suggestMock.mockResolvedValue(SUGGESTIONS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes the list as a combobox-controlled listbox of options', async () => {
    const { input } = await openList();

    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id);
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('highlights nothing until a key is pressed', async () => {
    await openList();

    expect(activeLabel()).toBeUndefined();
  });

  it('ArrowDown walks the list from the top', async () => {
    const { input } = await openList();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeLabel()).toBe(SUGGESTIONS[0]!.label);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeLabel()).toBe(SUGGESTIONS[1]!.label);
  });

  it('ArrowUp from nothing enters the list at its END', async () => {
    // Clamping from -1 would enter at the start and make both arrows do the
    // same thing.
    const { input } = await openList();

    fireEvent.keyDown(input, { key: 'ArrowUp' });

    expect(activeLabel()).toBe(SUGGESTIONS[2]!.label);
  });

  it('clamps at the bottom instead of wrapping to the top', async () => {
    const { input } = await openList();

    for (let i = 0; i < 6; i += 1) fireEvent.keyDown(input, { key: 'ArrowDown' });

    expect(activeLabel()).toBe(SUGGESTIONS[2]!.label);
  });

  it('clamps at the top instead of wrapping to the bottom', async () => {
    const { input } = await openList();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    for (let i = 0; i < 4; i += 1) fireEvent.keyDown(input, { key: 'ArrowUp' });

    expect(activeLabel()).toBe(SUGGESTIONS[0]!.label);
  });

  it('Home and End jump to the ends', async () => {
    const { input } = await openList();

    fireEvent.keyDown(input, { key: 'End' });
    expect(activeLabel()).toBe(SUGGESTIONS[2]!.label);

    fireEvent.keyDown(input, { key: 'Home' });
    expect(activeLabel()).toBe(SUGGESTIONS[0]!.label);
  });

  it('Escape closes the list', async () => {
    const { input } = await openList();

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('Tab closes the list without trapping focus', async () => {
    // Not prevented — moving on should move on; the list just must not be left
    // hanging over the next field.
    const { input } = await openList();

    const event = fireEvent.keyDown(input, { key: 'Tab' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(event).toBe(true); // not preventDefault()ed
  });

  it('Enter with nothing highlighted does not commit, and stays unswallowed', async () => {
    // So Enter still reaches the form and submits it.
    const { input, onChange } = await openList();
    onChange.mockClear();

    const event = fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).not.toHaveBeenCalled();
    expect(event).toBe(true);
  });

  it('ArrowDown re-opens a list that was closed, highlighting the first option', async () => {
    const { input } = await openList();
    fireEvent.keyDown(input, { key: 'Escape' });

    fireEvent.keyDown(input, { key: 'ArrowDown' });

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(activeLabel()).toBe(SUGGESTIONS[0]!.label);
  });

  it('ArrowUp re-opens a closed list at its last option', async () => {
    const { input } = await openList();
    fireEvent.keyDown(input, { key: 'Escape' });

    fireEvent.keyDown(input, { key: 'ArrowUp' });

    expect(activeLabel()).toBe(SUGGESTIONS[2]!.label);
  });

  it('hovering moves the keyboard highlight too, so the two never disagree', async () => {
    const { input } = await openList();
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    fireEvent.mouseEnter(screen.getAllByRole('option')[2]!);

    expect(activeLabel()).toBe(SUGGESTIONS[2]!.label);
  });

  it('ignores an unrelated key', async () => {
    const { input } = await openList();

    fireEvent.keyDown(input, { key: 'a' });

    expect(activeLabel()).toBeUndefined();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});
