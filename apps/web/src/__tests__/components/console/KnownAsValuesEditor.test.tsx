/**
 * Unit tests for KnownAsValuesEditor: the "known as" values an organisation
 * defines for the organisations under it.
 *
 * Covers: the empty state and notes, the status line and discard, the first
 * value becoming the default, saved rows with their default, adding, renaming
 * and removing rows (saved keys sent back, new rows without a key), the
 * default choice, the row limit, name checks before sending, the saved list
 * from the API, an error, a changed list from the page, the same list in a
 * new object (unsaved edits kept), the controls locked while saving, and the
 * per-row accessible names.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import {
  KNOWN_AS_MAX_VALUES,
  KNOWN_AS_NAME_MAX,
  type KnownAsValues,
} from '@aggregator-dpg/shared-primitives/user-org';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { KnownAsValuesEditor } from '@/components/console/KnownAsValuesEditor';

const ORG = '00000000-0000-4000-8000-0000000000b1';
const m = messages.console.org;

const SAVED: KnownAsValues = [
  { key: 'district', name: 'District', default: true },
  { key: 'block', name: 'Block' },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderIt(values: KnownAsValues = SAVED) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <KnownAsValuesEditor orgId={ORG} values={values} />
    </NextIntlClientProvider>,
  );
}

const save = () => screen.getByRole('button', { name: m.known_as_values_save });
const newValue = () => screen.getByLabelText(m.known_as_values_new);
const addBtn = () => screen.getByRole('button', { name: m.known_as_values_add });

function addValue(name: string) {
  fireEvent.change(newValue(), { target: { value: name } });
  fireEvent.click(addBtn());
}
const nameField = (n: number) => screen.getByLabelText(`Name of value ${n}`);
const defaults = () => screen.getAllByRole('radio', { name: /^Make .+ the default$/ });

/** The JSON body of the first PATCH sent. */
function sentBody(): unknown {
  const call = vi.mocked(global.fetch).mock.calls[0];
  return JSON.parse(String((call?.[1] as { body: string }).body));
}

describe('<KnownAsValuesEditor />', () => {
  const original = global.fetch;
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = original;
  });

  it('shows the empty state and the notes when there are no values', () => {
    renderIt([]);
    expect(screen.getByText(m.known_as_values_empty)).toBeInTheDocument();
    expect(screen.getByText(m.known_as_values_note_default)).toBeInTheDocument();
    expect(screen.getByText(m.known_as_values_remove_note)).toBeInTheDocument();
    expect(screen.getByText(m.known_as_values_unchanged)).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('makes the first value added to an empty list the default', () => {
    renderIt([]);
    addValue('District');
    expect(nameField(1)).toHaveValue('District');
    expect(defaults()[0]).toBeChecked();
    expect(screen.getByText(m.known_as_values_unsaved)).toBeInTheDocument();
  });

  it('discards unsaved changes', () => {
    renderIt();
    fireEvent.change(nameField(1), { target: { value: 'Zone' } });
    fireEvent.click(screen.getByRole('button', { name: m.known_as_values_discard }));
    expect(nameField(1)).toHaveValue('District');
    expect(save()).toBeDisabled();
    expect(screen.queryByRole('button', { name: m.known_as_values_discard })).toBeNull();
  });

  it('shows the saved values with their default, and no key field', () => {
    renderIt();
    expect(nameField(1)).toHaveValue('District');
    expect(nameField(1)).toHaveAttribute('maxLength', String(KNOWN_AS_NAME_MAX));
    expect(nameField(2)).toHaveValue('Block');
    expect(defaults()[0]).toBeChecked();
    expect(defaults()[1]).not.toBeChecked();
    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    expect(save()).toBeDisabled();
  });

  it('sends saved keys back, a new row without a key, and the new default', async () => {
    const after = [
      { key: 'district', name: 'Zone' },
      { key: 'block', name: 'Block' },
      { key: 'ward', name: 'Ward', default: true },
    ];
    vi.mocked(global.fetch).mockResolvedValue(json({ id: ORG, known_as_values: after }));
    renderIt();
    fireEvent.change(nameField(1), { target: { value: 'Zone' } });
    addValue('  Ward ');
    expect(newValue()).toHaveValue('');
    fireEvent.click(defaults()[2]!);
    fireEvent.click(save());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/org/known-as/${ORG}`,
      expect.objectContaining({ method: 'PATCH' }),
    );
    expect(sentBody()).toEqual({
      known_as_values: [
        { key: 'district', name: 'Zone' },
        { key: 'block', name: 'Block' },
        { name: 'Ward', default: true },
      ],
    });
    expect(screen.getByRole('status')).toHaveTextContent(m.saved);
    expect(save()).toBeDisabled();
  });

  it('removes a row and clears the default when it was the default', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ id: ORG, known_as_values: [SAVED[1]] }));
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'Remove District' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'After the removal, organisations known as District will be known as Aggregator when you save.',
    );
    expect(nameField(1)).toHaveValue('District');
    fireEvent.click(screen.getByRole('button', { name: m.known_as_values_remove_confirm }));
    for (const radio of defaults()) expect(radio).not.toBeChecked();
    fireEvent.click(save());
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(sentBody()).toEqual({ known_as_values: [{ key: 'block', name: 'Block' }] });
  });

  it('says how many organisations moved to the default after a save', async () => {
    vi.mocked(global.fetch).mockResolvedValue(
      json({ id: ORG, known_as_values: [SAVED[0]], reset_count: 3 }),
    );
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Block' }));
    fireEvent.click(screen.getByRole('button', { name: m.known_as_values_remove_confirm }));
    fireEvent.click(save());
    expect(
      await screen.findByText('Saved. 3 organisations changed to the default value.'),
    ).toBeInTheDocument();
  });

  it('warns before removing a saved value, naming where its organisations go', () => {
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Block' }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'After the removal, organisations known as Block will be known as District when you save.',
    );
    fireEvent.click(screen.getByRole('button', { name: m.known_as_values_cancel }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(nameField(2)).toHaveValue('Block');
    expect(save()).toBeDisabled();
  });

  it('removes a value added since the last save without asking', () => {
    renderIt();
    addValue('Ward');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Ward' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByDisplayValue('Ward')).toBeNull();
  });

  it('refuses an empty name before sending, and a repeated name when adding', () => {
    renderIt();
    fireEvent.change(nameField(2), { target: { value: ' ' } });
    fireEvent.click(save());
    expect(screen.getByText(m.known_as_values_name_required)).toBeInTheDocument();
    addValue('district ');
    expect(screen.getByText('\u201cdistrict\u201d is already in the list.')).toBeInTheDocument();
    expect(newValue()).toHaveValue('district ');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('stops adding rows at the limit', () => {
    const full = Array.from({ length: KNOWN_AS_MAX_VALUES }, (_, i) => ({
      key: `v_${i}`,
      name: `Value ${i}`,
    }));
    renderIt(full);
    expect(newValue()).toBeDisabled();
    expect(addBtn()).toBeDisabled();
    expect(
      screen.getByText(`You can have up to ${KNOWN_AS_MAX_VALUES} values.`),
    ).toBeInTheDocument();
  });

  it('shows the API message when the save fails', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ error: { code: 'FORBIDDEN' } }, 403));
    renderIt();
    fireEvent.change(nameField(2), { target: { value: 'Taluk' } });
    fireEvent.click(save());
    expect(await screen.findByText(messages.console.errors.forbidden)).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('takes a newer list from the page', () => {
    const { rerender } = renderIt();
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <KnownAsValuesEditor orgId={ORG} values={[{ key: 'ward', name: 'Ward' }]} />
      </NextIntlClientProvider>,
    );
    expect(nameField(1)).toHaveValue('Ward');
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
  });

  it("names each row's default and remove controls after the row", () => {
    renderIt();
    expect(screen.getByRole('radio', { name: 'Make District the default' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Make Block the default' })).not.toBeChecked();
    fireEvent.change(nameField(2), { target: { value: '' } });
    expect(screen.getByRole('radio', { name: 'Make value 2 the default' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove value 2' })).toBeInTheDocument();
  });

  it('locks every control while the save is in flight', async () => {
    let finish: (r: Response) => void = () => undefined;
    vi.mocked(global.fetch).mockReturnValue(
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    );
    renderIt();
    fireEvent.change(nameField(2), { target: { value: 'Taluk' } });
    fireEvent.click(save());
    await waitFor(() => expect(nameField(1)).toBeDisabled());
    expect(nameField(2)).toBeDisabled();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove District' })).toBeDisabled();
    expect(newValue()).toBeDisabled();
    finish(
      json({
        id: ORG,
        known_as_values: [SAVED[0], { key: 'block', name: 'Taluk' }],
      }),
    );
    await waitFor(() => expect(nameField(1)).toBeEnabled());
    expect(nameField(2)).toHaveValue('Taluk');
  });

  it('keeps unsaved edits when the page passes the same list in a new object', () => {
    const { rerender } = renderIt();
    fireEvent.change(nameField(2), { target: { value: 'Mandal' } });
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <KnownAsValuesEditor orgId={ORG} values={SAVED.map((e) => ({ ...e }))} />
      </NextIntlClientProvider>,
    );
    expect(nameField(2)).toHaveValue('Mandal');
    expect(save()).toBeEnabled();
  });
});
