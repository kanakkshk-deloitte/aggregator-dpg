/**
 * Unit tests for RjsfThemed — the wrapper this app puts around `@rjsf/core`'s
 * `Form`. Real RJSF + the real Ajv-2020 validator are used (this is exactly
 * what other view-level tests stub out via `vi.mock`), so these tests focus
 * on the wrapper's own value-add rather than re-testing RJSF's validation
 * engine:
 *
 *  - the custom widgets (Text/Textarea/Select/Date/CommaSeparatedArray/
 *    Checkbox/Checkboxes/Email/URL) that replace RJSF's unstyled defaults
 *  - the custom templates (Field/Object/Array) that add label/error/layout
 *    chrome RJSF doesn't provide out of the box
 *  - the `x-show-if` pruning integration (`lib/show-if`) wired into both the
 *    rendered schema and the `onChange` pass-through
 *  - the `onValidityChange` callback the rest of the app uses to gate submit
 *    buttons without re-implementing validation
 *
 * `TitleFieldTemplate: TitleField` (a component that always returns null) is
 * registered but, per `@rjsf/core`'s source, only ever invoked by the
 * *default* Object/ArrayFieldTemplate implementations — both of which this
 * file fully overrides with templates that render their own `<h3>` titles
 * directly. It is therefore unreachable through this wrapper's own template
 * wiring and is intentionally left uncovered (see final report).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { useState, type ReactNode } from 'react';
import type { RJSFSchema, UiSchema } from '@rjsf/utils';
import messages from '@/i18n/messages/en.json';
import { RjsfThemedForm, type RjsfThemedFormProps } from '@/components/forms/RjsfThemed';

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

/** Renders RjsfThemedForm inside the next-intl provider several widgets need. */
function renderThemed(props: RjsfThemedFormProps) {
  return render(
    <Wrapper>
      <RjsfThemedForm {...props} />
    </Wrapper>,
  );
}

/**
 * A self-controlled harness for tests that need multiple sequential
 * interactions (e.g. `userEvent.type` firing one onChange per keystroke) to
 * actually accumulate into form state, the way a real page's controlled
 * `formData` state would.
 */
function ControlledThemedForm(
  props: Omit<RjsfThemedFormProps, 'formData' | 'onChange'> & {
    initialData?: Record<string, unknown>;
    onDataChange?: (data: Record<string, unknown>) => void;
    onValidityChange?: (valid: boolean) => void;
  },
) {
  const { initialData, onDataChange, ...rest } = props;
  const [data, setData] = useState<Record<string, unknown>>(initialData ?? {});
  return (
    <RjsfThemedForm
      {...rest}
      formData={data}
      onChange={(e) => {
        const next = (e.formData ?? {}) as Record<string, unknown>;
        setData(next);
        onDataChange?.(next);
      }}
    />
  );
}

function renderControlled(
  props: Omit<RjsfThemedFormProps, 'formData' | 'onChange'> & {
    initialData?: Record<string, unknown>;
    onDataChange?: (data: Record<string, unknown>) => void;
  },
) {
  return render(
    <Wrapper>
      <ControlledThemedForm {...props} />
    </Wrapper>,
  );
}

describe('<RjsfThemedForm /> widgets', () => {
  it('TextWidget: renders a bd-input text field and accumulates typed value via onChange', async () => {
    const user = userEvent.setup();
    const schema: RJSFSchema = {
      type: 'object',
      properties: { name: { type: 'string', title: 'Name' } },
    };
    let latest: Record<string, unknown> = {};
    renderControlled({ schema, onDataChange: (d) => (latest = d) });
    const input = screen.getByLabelText('Name');
    expect(input).toHaveClass('bd-input');
    await user.type(input, 'Asha');
    expect(latest.name).toBe('Asha');
  });

  it('TextareaWidget: renders a textarea when ui:widget is textarea', async () => {
    const user = userEvent.setup();
    const schema: RJSFSchema = {
      type: 'object',
      properties: { bio: { type: 'string', title: 'Bio' } },
    };
    const uiSchema: UiSchema = { bio: { 'ui:widget': 'textarea' } };
    let latest: Record<string, unknown> = {};
    renderControlled({ schema, uiSchema, onDataChange: (d) => (latest = d) });
    const textarea = screen.getByLabelText('Bio');
    expect(textarea.tagName).toBe('TEXTAREA');
    await user.type(textarea, 'Hi');
    expect(latest.bio).toBe('Hi');
  });

  it('DateWidget: renders a native date input and reports the chosen date', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: { dob: { type: 'string', format: 'date', title: 'Date of birth' } },
    };
    const onChange = vi.fn();
    renderThemed({ schema, formData: {}, onChange });
    const input = screen.getByLabelText('Date of birth');
    expect(input).toHaveAttribute('type', 'date');
    fireEvent.change(input, { target: { value: '2024-01-15' } });
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    expect(lastCall.formData.dob).toBe('2024-01-15');
  });

  it('EmailWidget/URLWidget: pin the native input type via TextWidget aliasing', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email', title: 'Email' },
        site: { type: 'string', format: 'uri', title: 'Website' },
      },
    };
    renderThemed({ schema, formData: {}, onChange: () => {} });
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Website')).toHaveAttribute('type', 'url');
  });

  it('CheckboxWidget: toggles a boolean field on click', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: { subscribe: { type: 'boolean', title: 'Subscribe' } },
    };
    const onChange = vi.fn();
    renderThemed({ schema, formData: { subscribe: false }, onChange });
    const checkbox = screen.getByLabelText('Subscribe') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    expect(lastCall.formData.subscribe).toBe(true);
  });

  it('SelectWidget: renders enum options and reports the selected value', async () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        fruit: { type: 'string', enum: ['apple', 'banana'], title: 'Fruit' },
      },
    };
    const onChange = vi.fn();
    renderThemed({ schema, formData: {}, onChange });
    fireEvent.click(screen.getByRole('combobox'));
    const option = await screen.findByRole('option', { name: 'banana' });
    fireEvent.click(option);
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    expect(lastCall.formData.fruit).toBe('banana');
  });

  it('SelectWidget: an optional field with a value offers a clear button that empties it', async () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        fruit: { type: 'string', enum: ['apple', 'banana'], title: 'Fruit' },
      },
    };
    const onDataChange = vi.fn();
    renderControlled({ schema, initialData: { fruit: 'banana' }, onDataChange });

    await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }));

    // The key is dropped, not set to an empty string — `emptyValue` is
    // `undefined` here, which is what makes the field genuinely unanswered.
    const last = onDataChange.mock.calls[onDataChange.mock.calls.length - 1]![0];
    expect(last.fruit).toBeUndefined();
    expect(screen.getByRole('combobox')).toHaveTextContent('Select…');
  });

  it('SelectWidget: round-trips a numeric enum as a number, not a string', async () => {
    // Radix addresses items by string. Keying them on `String(opt.value)` and
    // handing that back would store "2" for a `type: number` field, which then
    // fails schema validation. Options are addressed by INDEX instead — the
    // same helpers the sibling Signals widget uses, so the two portals
    // round-trip a given schema identically. No non-string enum exists in this
    // repo's config trees today; this pins the behaviour before one does.
    const schema: RJSFSchema = {
      type: 'object',
      properties: { grade: { type: 'number', enum: [1, 2, 3], title: 'Grade' } },
    };
    const onDataChange = vi.fn();
    renderControlled({ schema, onDataChange });

    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: '2' }));

    const last = onDataChange.mock.calls[onDataChange.mock.calls.length - 1]![0];
    expect(last.grade).toBe(2);
    expect(last.grade).not.toBe('2');
  });

  it('SelectWidget: shows the selected label for a value that is not a string', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: { grade: { type: 'number', enum: [1, 2, 3], title: 'Grade' } },
    };
    renderThemed({ schema, formData: { grade: 3 }, onChange: vi.fn() });
    expect(screen.getByRole('combobox')).toHaveTextContent('3');
  });

  it('SelectWidget: an empty select shows the "Select…" placeholder', () => {
    // RJSF passes `placeholder: ''` rather than undefined, so the widget's
    // fallback has to be a truthiness check — with `??` every empty select
    // rendered a blank box.
    const schema: RJSFSchema = {
      type: 'object',
      properties: { fruit: { type: 'string', enum: ['apple', 'banana'], title: 'Fruit' } },
    };
    renderThemed({ schema, formData: {}, onChange: vi.fn() });
    expect(screen.getByRole('combobox')).toHaveTextContent('Select…');
  });

  it('SelectWidget: offers no clear button when the field is empty, required, or disabled', () => {
    const optional: RJSFSchema = {
      type: 'object',
      properties: { fruit: { type: 'string', enum: ['apple', 'banana'], title: 'Fruit' } },
    };

    // Empty: there is nothing to clear, so the button would be dead chrome.
    const empty = renderThemed({ schema: optional, formData: {}, onChange: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Clear selection' })).not.toBeInTheDocument();
    empty.unmount();

    // Required: emptying it is not a state the field is allowed to hold, so
    // offering the button would invite a validation error rather than a choice.
    const requiredSchema: RJSFSchema = { ...optional, required: ['fruit'] };
    const req = renderThemed({
      schema: requiredSchema,
      formData: { fruit: 'banana' },
      onChange: vi.fn(),
    });
    expect(screen.queryByRole('button', { name: 'Clear selection' })).not.toBeInTheDocument();
    req.unmount();

    // Disabled: the whole widget is locked.
    renderThemed({
      schema: optional,
      formData: { fruit: 'banana' },
      onChange: vi.fn(),
      disabled: true,
    });
    expect(screen.queryByRole('button', { name: 'Clear selection' })).not.toBeInTheDocument();
  });

  it('CommaSeparatedArrayWidget: splits typed text into a trimmed string array on blur', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' }, title: 'Tags' } },
    };
    const uiSchema: UiSchema = { tags: { 'ui:widget': 'CommaSeparatedArrayWidget' } };
    const onChange = vi.fn();
    renderThemed({ schema, uiSchema, formData: {}, onChange });
    const input = screen.getByLabelText('Tags');
    fireEvent.change(input, { target: { value: 'red, green ,blue' } });
    fireEvent.blur(input);
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    expect(lastCall.formData.tags).toEqual(['red', 'green', 'blue']);
    // Canonical display re-flows spacing after blur.
    expect((input as HTMLInputElement).value).toBe('red, green, blue');
  });

  it('CommaSeparatedArrayWidget: clears to undefined when all tokens are removed', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' }, title: 'Tags' } },
    };
    const uiSchema: UiSchema = { tags: { 'ui:widget': 'CommaSeparatedArrayWidget' } };
    const onChange = vi.fn();
    renderThemed({ schema, uiSchema, formData: { tags: ['a'] }, onChange });
    const input = screen.getByLabelText('Tags');
    fireEvent.change(input, { target: { value: '' } });
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    expect(lastCall.formData.tags).toBeUndefined();
  });

  it('CheckboxesWidget: renders a MultiSelect for array-of-enum and reports selections', async () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        langs: {
          type: 'array',
          items: { type: 'string', enum: ['js', 'py', 'go'] },
          uniqueItems: true,
          title: 'Languages',
        },
      },
    };
    const uiSchema: UiSchema = { langs: { 'ui:widget': 'CheckboxesWidget' } };
    const onChange = vi.fn();
    renderThemed({ schema, uiSchema, formData: {}, onChange });
    // The trigger's accessible name comes from its associated <label>
    // ("Languages"), not its placeholder text.
    fireEvent.click(screen.getByLabelText('Languages'));
    const jsOption = await screen.findByRole('button', { name: 'js', exact: true });
    fireEvent.click(jsOption);
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]![0];
    expect(lastCall.formData.langs).toEqual(['js']);
  });

  // The `ui:widget` name the config tree actually uses is RJSF's lowercase
  // `checkboxes` alias, not the registry key `CheckboxesWidget` the test above
  // names directly. Pinned because the alias is what makes a `minItems: 1`
  // array-of-enum satisfiable at all: without it RJSF's multi-select path
  // falls back to the single-value SelectWidget, whose scalar write RJSF
  // discards, and FieldTemplate treats the widget-less array as a container
  // and drops its label and description (the ALIMCO org-registration bug).
  it('array-of-enum via the "checkboxes" alias: keeps its label and writes an array', async () => {
    const schema: RJSFSchema = {
      type: 'object',
      required: ['aggregator_type'],
      properties: {
        aggregator_type: {
          type: 'array',
          title: 'Aggregator Type',
          description: 'Which participants this organisation represents.',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', enum: ['seeker', 'provider'] },
        },
      },
    };
    const uiSchema: UiSchema = {
      aggregator_type: {
        'ui:widget': 'checkboxes',
        'ui:enumNames': ['Seekers', 'Service Providers'],
      },
    };
    let latest: Record<string, unknown> = {};
    const validity: boolean[] = [];
    renderControlled({
      schema,
      uiSchema,
      initialData: {},
      onDataChange: (d) => {
        latest = d;
      },
      onValidityChange: (v) => validity.push(v),
    });

    // Label + description survive, and the required marker is on the label —
    // all three are what the container code path silently swallows.
    expect(screen.getByText('Aggregator Type')).toBeTruthy();
    expect(screen.getByText('Which participants this organisation represents.')).toBeTruthy();
    expect(validity[validity.length - 1]).toBe(false);

    // `/Aggregator Type/`, not the exact string: the required marker lives
    // inside the <label>, so the trigger's accessible name is "Aggregator Type *".
    fireEvent.click(screen.getByLabelText(/Aggregator Type/));
    fireEvent.click(await screen.findByRole('button', { name: 'Seekers', exact: true }));

    // An array, not the bare 'seeker' a single-select would have written.
    expect(latest['aggregator_type']).toEqual(['seeker']);
    expect(validity[validity.length - 1]).toBe(true);
  });

  it('ConsentCheckbox: wires the ConsentCheckbox widget through formContext', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        consent: {
          type: 'object',
          properties: { value: { type: 'boolean', title: 'Consent' } },
        },
      },
    };
    const uiSchema: UiSchema = { consent: { value: { 'ui:widget': 'ConsentCheckbox' } } };
    renderThemed({ schema, uiSchema, formData: {}, onChange: () => {}, formContext: {} });
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });

  it('ConsentCheckbox: formContext reaches the widget, so the consent links render', () => {
    // Guards an RJSF v6 change that types cannot catch: `formContext` moved off
    // the top-level widget props onto `registry.formContext`, and `WidgetProps`
    // extends `GenericObjectType`, so reading `props.formContext` still compiles
    // and silently yields undefined. The only visible symptom is the widget
    // quietly falling back to plain-text labels instead of clickable links —
    // which the empty-formContext test above cannot distinguish.
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        consent: {
          type: 'object',
          properties: { value: { type: 'boolean', title: 'Consent' } },
        },
      },
    };
    const uiSchema: UiSchema = { consent: { value: { 'ui:widget': 'ConsentCheckbox' } } };
    const consentContent = {
      terms: { version: 1, title: 'Terms of Service', content: '# Terms' },
      privacy: { version: 1, title: 'Privacy Policy', content: '# Privacy' },
    };
    renderThemed({
      schema,
      uiSchema,
      formData: {},
      onChange: () => {},
      formContext: { consentContent },
    });

    expect(screen.getByRole('button', { name: 'Terms of Service' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Privacy Policy' })).toBeInTheDocument();
  });
});

describe('<RjsfThemedForm /> templates', () => {
  it('FieldTemplate: a `ui:widget: hidden` field renders nothing (no label, no input)', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        visible: { type: 'string', title: 'Visible field' },
        secret: { type: 'string', title: 'Secret field' },
      },
    };
    const uiSchema: UiSchema = { secret: { 'ui:widget': 'hidden' } };
    renderThemed({ schema, uiSchema, formData: {}, onChange: () => {} });
    expect(screen.getByLabelText('Visible field')).toBeInTheDocument();
    expect(screen.queryByText('Secret field')).toBeNull();
    expect(screen.queryByLabelText('Secret field')).toBeNull();
  });

  it('FieldTemplate: shows a required marker and a red-border error style after a failed submit', () => {
    const schema: RJSFSchema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', title: 'Name' } },
    };
    const { container } = renderThemed({
      schema,
      formData: {},
      onChange: () => {},
      onSubmit: vi.fn(),
    });
    expect(screen.getByText('*')).toBeInTheDocument();
    const form = container.querySelector('form')!;
    fireEvent.submit(form);
    const errorWrap = container.querySelector(
      '.form-group.\\[\\&_\\.bd-input\\]\\:border-rose-400',
    );
    expect(errorWrap).toBeTruthy();
  });

  it('ObjectFieldTemplate: renders a nested object title/description and grid layout by default', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          title: 'Address',
          description: 'Where to reach you',
          properties: {
            city: { type: 'string', title: 'City' },
            zip: { type: 'string', title: 'Zip' },
          },
        },
      },
    };
    renderThemed({ schema, formData: {}, onChange: () => {} });
    expect(screen.getByText('Address')).toBeInTheDocument();
    expect(screen.getByText('Where to reach you')).toBeInTheDocument();
    expect(screen.getByLabelText('City')).toBeInTheDocument();
    expect(screen.getByLabelText('Zip')).toBeInTheDocument();
    // Default grid layout applies to the address group's field container.
    const addressHeading = screen.getByText('Address');
    const fieldGroup = addressHeading.closest('.space-y-3');
    expect(fieldGroup!.querySelector('.grid.grid-cols-1')).toBeTruthy();
  });

  it('ObjectFieldTemplate: suppresses the title when ui:title is false', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          title: 'Address',
          properties: { city: { type: 'string', title: 'City' } },
        },
      },
    };
    const uiSchema: UiSchema = { address: { 'ui:title': false } };
    renderThemed({ schema, uiSchema, formData: {}, onChange: () => {} });
    expect(screen.queryByText('Address')).toBeNull();
    expect(screen.getByLabelText('City')).toBeInTheDocument();
  });

  it('ObjectFieldTemplate: honours ui:layout stack instead of the grid default', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        address: {
          type: 'object',
          title: 'Address',
          properties: { city: { type: 'string', title: 'City' } },
        },
      },
    };
    const uiSchema: UiSchema = { address: { 'ui:layout': 'stack' } };
    renderThemed({ schema, uiSchema, formData: {}, onChange: () => {} });
    // Scope the assertion to the "Address" group's own field container —
    // the root object also renders a (grid) container for its top-level
    // properties, so a page-wide grid query would give a false negative.
    const addressHeading = screen.getByText('Address');
    const fieldGroup = addressHeading.closest('.space-y-3')!;
    expect(fieldGroup.querySelector('.flex.flex-col.gap-3')).toBeTruthy();
    expect(fieldGroup.querySelector('.grid.grid-cols-1')).toBeNull();
  });

  it('ArrayFieldTemplate: numbers multiple items and offers Remove; hides both for a single item', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        contacts: {
          type: 'array',
          title: 'Contacts',
          items: {
            type: 'object',
            properties: { phone: { type: 'string', title: 'Phone' } },
          },
        },
      },
    };
    const { rerender } = renderThemed({
      schema,
      formData: { contacts: [{ phone: '1' }] },
      onChange: () => {},
    });
    expect(screen.queryByText(/Entry 1/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();

    rerender(
      <Wrapper>
        <RjsfThemedForm
          schema={schema}
          formData={{ contacts: [{ phone: '1' }, { phone: '2' }] }}
          onChange={() => {}}
        />
      </Wrapper>,
    );
    expect(screen.getByText(/Entry 1/)).toBeInTheDocument();
    expect(screen.getByText(/Entry 2/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
  });

  it('ArrayFieldTemplate: clicking "Add another" appends a new item', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        contacts: {
          type: 'array',
          title: 'Contacts',
          items: {
            type: 'object',
            properties: { phone: { type: 'string', title: 'Phone' } },
          },
        },
      },
    };
    let latest: Record<string, unknown> = { contacts: [{ phone: '1' }] };
    renderControlled({
      schema,
      initialData: { contacts: [{ phone: '1' }] },
      onDataChange: (d) => (latest = d),
    });
    fireEvent.click(screen.getByRole('button', { name: /Add another/i }));
    expect((latest.contacts as unknown[]).length).toBe(2);
  });

  it('ArrayFieldTemplate: clicking Remove drops that item from the array', () => {
    // Covers the RJSF v6 item-callback change directly. In v5 the template
    // called `item.onDropIndexClick(item.index)`, which *returned* a handler;
    // v6's `buttonsProps.onRemoveItem` *is* the handler. Wiring the two shapes
    // up the wrong way round still renders a Remove button that does nothing,
    // so asserting the button exists is not enough — it has to be clicked.
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        contacts: {
          type: 'array',
          title: 'Contacts',
          items: {
            type: 'object',
            properties: { phone: { type: 'string', title: 'Phone' } },
          },
        },
      },
    };
    let latest: Record<string, unknown> = { contacts: [{ phone: '1' }, { phone: '2' }] };
    renderControlled({
      schema,
      initialData: { contacts: [{ phone: '1' }, { phone: '2' }] },
      onDataChange: (d) => (latest = d),
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(latest.contacts).toEqual([{ phone: '2' }]);
  });
});

describe('<RjsfThemedForm /> x-show-if pruning', () => {
  const schema: RJSFSchema = {
    type: 'object',
    properties: {
      hasPets: { type: 'string', enum: ['yes', 'no'], title: 'Has pets?' },
      petName: {
        type: 'string',
        title: 'Pet name',
        'x-show-if': { hasPets: ['yes'] },
      } as RJSFSchema,
    },
  };

  it('hides a dependent field until the control value satisfies x-show-if', () => {
    renderThemed({ schema, formData: {}, onChange: () => {} });
    expect(screen.queryByLabelText('Pet name')).toBeNull();
  });

  it('reveals the dependent field once the control value matches', async () => {
    renderControlled({ schema });
    fireEvent.click(screen.getByRole('combobox'));
    const yesOption = await screen.findByRole('option', { name: 'yes' });
    fireEvent.click(yesOption);
    expect(screen.getByLabelText('Pet name')).toBeInTheDocument();
  });

  it('clears the dependent field value once it becomes hidden again', () => {
    const onChange = vi.fn();
    const { rerender } = renderThemed({
      schema,
      formData: { hasPets: 'yes', petName: 'Rex' },
      onChange,
    });
    expect(screen.getByLabelText('Pet name')).toBeInTheDocument();
    rerender(
      <Wrapper>
        <RjsfThemedForm
          schema={schema}
          formData={{ hasPets: 'no', petName: 'Rex' }}
          onChange={onChange}
        />
      </Wrapper>,
    );
    expect(screen.queryByLabelText('Pet name')).toBeNull();
  });
});

describe('<RjsfThemedForm /> onValidityChange', () => {
  it('reports false while a required field is empty and true once filled', async () => {
    const user = userEvent.setup();
    const schema: RJSFSchema = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', title: 'Name' } },
    };
    const onValidityChange = vi.fn();
    renderControlled({ schema, onValidityChange });
    expect(onValidityChange).toHaveBeenCalledWith(false);
    onValidityChange.mockClear();
    // The required marker appends " *" to the label text, so match loosely.
    await user.type(screen.getByLabelText(/Name/), 'Asha');
    expect(onValidityChange).toHaveBeenCalledWith(true);
  });

  it('excludes an x-show-if-hidden required field from the validity check', () => {
    const schema: RJSFSchema = {
      type: 'object',
      required: ['petName'],
      properties: {
        hasPets: { type: 'string', enum: ['yes', 'no'], title: 'Has pets?' },
        petName: {
          type: 'string',
          title: 'Pet name',
          'x-show-if': { hasPets: ['yes'] },
        } as RJSFSchema,
      },
    };
    const onValidityChange = vi.fn();
    renderThemed({ schema, formData: {}, onChange: () => {}, onValidityChange });
    // petName is required by the raw schema but currently hidden by x-show-if,
    // so the pruned schema used for validity has no unmet requirement.
    expect(onValidityChange).toHaveBeenCalledWith(true);
  });
});

describe('<RjsfThemedForm /> wrapper behaviour', () => {
  it('applies a custom className to the outer wrapper div', () => {
    const schema: RJSFSchema = { type: 'object', properties: {} };
    const { container } = renderThemed({
      schema,
      formData: {},
      onChange: () => {},
      className: 'my-form',
    });
    expect(container.querySelector('div.my-form')).toBeTruthy();
  });

  it('calls onSubmit with the current form data when the form is submitted', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: { name: { type: 'string', title: 'Name' } },
    };
    const onSubmit = vi.fn();
    const { container } = renderThemed({
      schema,
      formData: { name: 'Asha' },
      onChange: () => {},
      onSubmit,
    });
    fireEvent.submit(container.querySelector('form')!);
    expect(onSubmit).toHaveBeenCalled();
    const arg = onSubmit.mock.calls[0]![0];
    expect(arg.formData).toEqual({ name: 'Asha' });
  });
});
