/**
 * Unit tests for MultiLocationAutocompleteWidget.
 *
 * Backs an array-typed `location` field (up-gzb's `service_provider.serviceAreas`).
 * It keeps two structures in step — the string array RJSF stores and the
 * per-row coordinates the page submits — across add, remove and re-edit, and
 * the two drifting apart is the failure worth guarding: a row's coordinate
 * surviving the row's deletion would submit a point for a place the registrant
 * removed.
 *
 * As in the single-value widget's suite, `formContext` is nested under
 * `registry` because that is the only place RJSF v6 exposes it (signals-dpg#506).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import type { GeoSuggestion } from '@/lib/geo/types';

const suggestMock = vi.fn<(query: string, signal?: AbortSignal) => Promise<GeoSuggestion[]>>();

vi.mock('@/lib/geo/provider', () => ({
  getGeoProvider: () => ({ suggest: suggestMock }),
}));

import { MultiLocationAutocompleteWidget } from '@/components/forms/custom-widgets/MultiLocationAutocompleteWidget';

const BENGALURU: GeoSuggestion = { label: 'Bengaluru, Karnataka', lat: 12.9716, lng: 77.5946 };
const MYSURU: GeoSuggestion = { label: 'Mysuru, Karnataka', lat: 12.2958, lng: 76.6394 };

function makeProps({
  formContext = {},
  isPrimaryLocation = true,
  ...overrides
}: Record<string, unknown> & {
  formContext?: Record<string, unknown>;
  isPrimaryLocation?: boolean;
} = {}) {
  return {
    id: 'root_serviceAreas',
    value: undefined,
    required: false,
    disabled: false,
    readonly: false,
    onChange: vi.fn(),
    label: 'Service areas',
    schema: { type: 'array' },
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

/** Types into row `index` and lets the debounce elapse. */
async function typeInRow(index: number, text: string) {
  fireEvent.change(screen.getAllByRole('combobox')[index]!, { target: { value: text } });
  await vi.advanceTimersByTimeAsync(300);
}

/** Picks the single listed suggestion for row `index`. */
async function pickSuggestionInRow(index: number, label: string) {
  const row = screen.getAllByRole('combobox')[index]!.closest('div')!.parentElement!;
  fireEvent.mouseDown(await within(row).findByRole('option', { name: label }));
}

describe('MultiLocationAutocompleteWidget', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    suggestMock.mockReset();
    suggestMock.mockResolvedValue([BENGALURU]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders one empty row for a fresh field', () => {
    render(
      <Wrapper>
        <MultiLocationAutocompleteWidget {...(makeProps() as never)} />
      </Wrapper>,
    );

    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('renders one row per existing value', () => {
    render(
      <Wrapper>
        <MultiLocationAutocompleteWidget
          {...(makeProps({ value: ['Bengaluru', 'Mysuru'] }) as never)}
        />
      </Wrapper>,
    );

    expect(screen.getAllByRole('combobox')).toHaveLength(2);
  });

  it('reports a picked coordinate through registry.formContext (signals-dpg#506)', async () => {
    const onLocationsResolved = vi.fn();
    render(
      <Wrapper>
        <MultiLocationAutocompleteWidget
          {...(makeProps({ formContext: { onLocationsResolved } }) as never)}
        />
      </Wrapper>,
    );

    await typeInRow(0, 'bengaluru');
    await pickSuggestionInRow(0, BENGALURU.label);

    expect(onLocationsResolved).toHaveBeenLastCalledWith([
      { lat: 12.9716, lng: 77.5946, label: BENGALURU.label },
    ]);
  });

  it('writes the picked labels back as a string array', async () => {
    const onChange = vi.fn();
    render(
      <Wrapper>
        <MultiLocationAutocompleteWidget {...(makeProps({ onChange }) as never)} />
      </Wrapper>,
    );

    await typeInRow(0, 'bengaluru');
    await pickSuggestionInRow(0, BENGALURU.label);

    expect(onChange).toHaveBeenLastCalledWith([BENGALURU.label]);
  });

  it('adds a row and collects a coordinate per row', async () => {
    const onLocationsResolved = vi.fn();
    render(
      <Wrapper>
        <MultiLocationAutocompleteWidget
          {...(makeProps({ formContext: { onLocationsResolved } }) as never)}
        />
      </Wrapper>,
    );

    await typeInRow(0, 'bengaluru');
    await pickSuggestionInRow(0, BENGALURU.label);

    fireEvent.click(screen.getByRole('button', { name: messages.form.location_add }));
    suggestMock.mockResolvedValue([MYSURU]);
    await typeInRow(1, 'mysuru');
    await pickSuggestionInRow(1, MYSURU.label);

    expect(onLocationsResolved).toHaveBeenLastCalledWith([
      { lat: 12.9716, lng: 77.5946, label: BENGALURU.label },
      { lat: 12.2958, lng: 76.6394, label: MYSURU.label },
    ]);
  });

  it('drops a removed row’s coordinate along with its value', async () => {
    // The structures must stay in step — a coordinate outliving its row would
    // submit a point for a place the registrant deleted.
    const onLocationsResolved = vi.fn();
    const onChange = vi.fn();
    render(
      <Wrapper>
        <MultiLocationAutocompleteWidget
          {...(makeProps({ onChange, formContext: { onLocationsResolved } }) as never)}
        />
      </Wrapper>,
    );

    await typeInRow(0, 'bengaluru');
    await pickSuggestionInRow(0, BENGALURU.label);

    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));

    expect(onLocationsResolved).toHaveBeenLastCalledWith([]);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('clears a row’s coordinate as soon as its text is edited again', async () => {
    const onLocationsResolved = vi.fn();
    render(
      <Wrapper>
        <MultiLocationAutocompleteWidget
          {...(makeProps({ formContext: { onLocationsResolved } }) as never)}
        />
      </Wrapper>,
    );

    await typeInRow(0, 'bengaluru');
    await pickSuggestionInRow(0, BENGALURU.label);
    onLocationsResolved.mockClear();

    await typeInRow(0, 'bengaluru north');

    expect(onLocationsResolved).toHaveBeenLastCalledWith([]);
  });

  it('emits undefined, not [], when every row is blank', async () => {
    // Same reason as the single-value widget: `[]` counts as present for a
    // required array field, `undefined` does not.
    const onChange = vi.fn();
    render(
      <Wrapper>
        <MultiLocationAutocompleteWidget
          {...(makeProps({ onChange, value: ['Bengaluru'] }) as never)}
        />
      </Wrapper>,
    );

    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: '' } });

    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('honours maxItems by disabling the add button at the cap', () => {
    render(
      <Wrapper>
        <MultiLocationAutocompleteWidget
          {...(makeProps({
            schema: { type: 'array', maxItems: 2 },
            value: ['Bengaluru', 'Mysuru'],
          }) as never)}
        />
      </Wrapper>,
    );

    expect(screen.getByRole('button', { name: messages.form.location_add })).toBeDisabled();
  });

  it('does not report coordinates for a secondary location field', async () => {
    const onLocationsResolved = vi.fn();
    render(
      <Wrapper>
        <MultiLocationAutocompleteWidget
          {...(makeProps({
            formContext: { onLocationsResolved },
            isPrimaryLocation: false,
          }) as never)}
        />
      </Wrapper>,
    );

    await typeInRow(0, 'bengaluru');
    await pickSuggestionInRow(0, BENGALURU.label);

    expect(onLocationsResolved).not.toHaveBeenCalled();
  });

  it('disables every control when the field is read-only', () => {
    render(
      <Wrapper>
        <MultiLocationAutocompleteWidget
          {...(makeProps({ readonly: true, value: ['Bengaluru'] }) as never)}
        />
      </Wrapper>,
    );

    expect(screen.getAllByRole('combobox')[0]).toBeDisabled();
    expect(screen.getByRole('button', { name: messages.form.location_add })).toBeDisabled();
  });

  it('closes a row’s suggestion list shortly after it loses focus', async () => {
    // Delayed rather than immediate, so a click on a suggestion still lands
    // before blur tears the list down.
    render(
      <Wrapper>
        <MultiLocationAutocompleteWidget {...(makeProps() as never)} />
      </Wrapper>,
    );

    await typeInRow(0, 'bengaluru');
    await screen.findByRole('listbox');

    // focusOut, not blur: React attaches onBlur to the bubbling `focusout`
    // event, and a non-bubbling `blur` never reaches its listener.
    fireEvent.focusOut(screen.getAllByRole('combobox')[0]!);

    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('cancels a removed row’s in-flight search instead of leaving it to land', async () => {
    // The row's debounce and abort handles live outside React state; dropping
    // the row without cancelling them would let a superseded lookup resolve
    // into a row index that no longer exists.
    render(
      <Wrapper>
        <MultiLocationAutocompleteWidget
          {...(makeProps({ value: ['Bengaluru', 'Mysuru'] }) as never)}
        />
      </Wrapper>,
    );

    // Start a search on the second row, then remove that row before the
    // debounce fires.
    fireEvent.change(screen.getAllByRole('combobox')[1]!, { target: { value: 'mysuru' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Remove/ })[1]!);
    await vi.advanceTimersByTimeAsync(600);

    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not query the geocoder for a query shorter than three characters', async () => {
    render(
      <Wrapper>
        <MultiLocationAutocompleteWidget {...(makeProps() as never)} />
      </Wrapper>,
    );

    await typeInRow(0, 'be');

    expect(suggestMock).not.toHaveBeenCalled();
  });
});
