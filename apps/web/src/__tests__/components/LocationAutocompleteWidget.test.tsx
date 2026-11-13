/**
 * Unit tests for LocationAutocompleteWidget.
 *
 * The headline case is the `registry.formContext` read. RJSF v6 stopped
 * spreading `formContext` onto widget props, and because `WidgetProps` extends
 * an index-signature type, reading the dead prop still type-checks — so the only
 * thing standing between this widget and signals-dpg#506 (picked coordinate
 * silently discarded, form otherwise working perfectly) is a test that asserts
 * the callback actually fires. Everything else here covers the contract the
 * submit path depends on: clearing emits `undefined`, editing after a pick drops
 * the stale coordinate, and a secondary field never reports one at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import type { GeoSuggestion } from '@/lib/geo/types';

const suggestMock = vi.fn<(query: string, signal?: AbortSignal) => Promise<GeoSuggestion[]>>();

vi.mock('@/lib/geo/provider', () => ({
  getGeoProvider: () => ({ suggest: suggestMock }),
}));

import { LocationAutocompleteWidget } from '@/components/forms/custom-widgets/LocationAutocompleteWidget';

const JAYANAGAR: GeoSuggestion = {
  label: 'Jayanagar, Bengaluru, Karnataka, India',
  lat: 12.9251,
  lng: 77.5938,
  components: { locality: 'Jayanagar', city: 'Bengaluru', state: 'Karnataka' },
};

/**
 * Minimal RJSF `WidgetProps` for direct rendering.
 *
 * `formContext` is nested under `registry` — where RJSF v6 puts it and where the
 * widget reads it. A test that passed it flat would pass against the broken
 * implementation too, which is the whole trap being guarded here.
 */
function makeProps({
  formContext = {},
  isPrimaryLocation = true,
  ...overrides
}: Record<string, unknown> & {
  formContext?: Record<string, unknown>;
  isPrimaryLocation?: boolean;
} = {}) {
  return {
    id: 'root_location',
    value: '',
    required: true,
    disabled: false,
    readonly: false,
    onChange: vi.fn(),
    label: 'Location',
    schema: {},
    options: { isPrimaryLocation },
    uiSchema: {},
    registry: { formContext } as never,
    rawErrors: [],
    ...overrides,
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

/** Types into the combobox and lets the 300ms debounce elapse. */
async function typeAndAwaitSuggestions(text: string) {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: text } });
  await vi.advanceTimersByTimeAsync(300);
}

describe('LocationAutocompleteWidget', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    suggestMock.mockReset();
    suggestMock.mockResolvedValue([JAYANAGAR]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the picked coordinate through registry.formContext (signals-dpg#506)', async () => {
    const onLocationResolved = vi.fn();
    render(
      <Wrapper>
        <LocationAutocompleteWidget
          {...(makeProps({ formContext: { onLocationResolved } }) as never)}
        />
      </Wrapper>,
    );

    await typeAndAwaitSuggestions('jayanagar');
    const option = await screen.findByRole('option', { name: JAYANAGAR.label });
    fireEvent.mouseDown(option);

    // The coordinate, not merely "was called" — this is the value that reaches
    // the submit payload as item_locations.
    expect(onLocationResolved).toHaveBeenCalledWith(
      expect.objectContaining({ lat: 12.9251, lng: 77.5938 }),
    );
  });

  it('reports address components alongside the coordinate', async () => {
    // The page deliberately drops these before submit (see the narrowing in
    // PublicRegistrationView) — but the widget still reports them, so that a
    // caller which DOES want them, such as a future coarsen-before-submit path,
    // has them without a second geocode.
    const onLocationResolved = vi.fn();
    render(
      <Wrapper>
        <LocationAutocompleteWidget
          {...(makeProps({ formContext: { onLocationResolved } }) as never)}
        />
      </Wrapper>,
    );

    await typeAndAwaitSuggestions('jayanagar');
    fireEvent.mouseDown(await screen.findByRole('option', { name: JAYANAGAR.label }));

    expect(onLocationResolved.mock.calls.at(-1)?.[0]).toMatchObject({
      components: { city: 'Bengaluru' },
    });
  });

  it('writes the picked label back to the form', async () => {
    const onChange = vi.fn();
    render(
      <Wrapper>
        <LocationAutocompleteWidget {...(makeProps({ onChange }) as never)} />
      </Wrapper>,
    );

    await typeAndAwaitSuggestions('jayanagar');
    fireEvent.mouseDown(await screen.findByRole('option', { name: JAYANAGAR.label }));

    expect(onChange).toHaveBeenLastCalledWith(JAYANAGAR.label);
  });

  it('drops the previous coordinate as soon as the text is edited again', async () => {
    // Otherwise a registrant could pick an address, type over it, and submit the
    // typed text with the *old* address's coordinate attached.
    const onLocationResolved = vi.fn();
    render(
      <Wrapper>
        <LocationAutocompleteWidget
          {...(makeProps({ formContext: { onLocationResolved } }) as never)}
        />
      </Wrapper>,
    );

    await typeAndAwaitSuggestions('jayanagar');
    fireEvent.mouseDown(await screen.findByRole('option', { name: JAYANAGAR.label }));
    onLocationResolved.mockClear();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'somewhere else' } });

    expect(onLocationResolved).toHaveBeenCalledWith(null);
  });

  it('emits undefined rather than "" when cleared, so a required field re-invalidates', async () => {
    // An empty string counts as present for JSON-Schema `required`; undefined
    // does not. Getting this wrong lets an emptied location pass validation.
    const onChange = vi.fn();
    render(
      <Wrapper>
        <LocationAutocompleteWidget {...(makeProps({ onChange, value: 'Jayanagar' }) as never)} />
      </Wrapper>,
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });

    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('does not report a coordinate for a secondary location field', async () => {
    // Only the primary field feeds item_locations; a secondary one is
    // autocomplete-only, matching how Signals treats the same marker.
    const onLocationResolved = vi.fn();
    render(
      <Wrapper>
        <LocationAutocompleteWidget
          {...(makeProps({
            formContext: { onLocationResolved },
            isPrimaryLocation: false,
          }) as never)}
        />
      </Wrapper>,
    );

    await typeAndAwaitSuggestions('jayanagar');
    fireEvent.mouseDown(await screen.findByRole('option', { name: JAYANAGAR.label }));

    expect(onLocationResolved).not.toHaveBeenCalled();
  });

  it('does not query the geocoder for a query shorter than three characters', async () => {
    render(
      <Wrapper>
        <LocationAutocompleteWidget {...(makeProps() as never)} />
      </Wrapper>,
    );

    await typeAndAwaitSuggestions('ja');

    expect(suggestMock).not.toHaveBeenCalled();
  });

  it('renders no listbox when the geocoder returns nothing', async () => {
    suggestMock.mockResolvedValue([]);
    render(
      <Wrapper>
        <LocationAutocompleteWidget {...(makeProps() as never)} />
      </Wrapper>,
    );

    await typeAndAwaitSuggestions('nowhere at all');

    await waitFor(() => expect(suggestMock).toHaveBeenCalled());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('commits the keyboard-highlighted option on Enter', async () => {
    const onChange = vi.fn();
    render(
      <Wrapper>
        <LocationAutocompleteWidget {...(makeProps({ onChange }) as never)} />
      </Wrapper>,
    );

    await typeAndAwaitSuggestions('jayanagar');
    await screen.findByRole('option', { name: JAYANAGAR.label });
    // Let the hook's "new results clear the highlight" effect settle BEFORE the
    // arrow key. It is a passive effect keyed on the suggestions array, so
    // without this flush it can land after ArrowDown and reset the highlight it
    // just set — Enter then finds nothing selected and correctly does nothing.
    await vi.advanceTimersByTimeAsync(0);

    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onChange).toHaveBeenLastCalledWith(JAYANAGAR.label);
  });
});
