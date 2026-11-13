/**
 * View test: <PublicRegistrationView /> tells the participant which field is
 * wrong (#903).
 *
 * Renders the REAL RJSF form (no shim): the defect lived in the interplay
 * between RJSF's validity, the disabled Submit button and the deferred error
 * display, which a shim would hide. Covers:
 *  - Submit is never disabled by an invalid field; clicking it shows the
 *    field's error inline and names it in the banner.
 *  - The message is readable ("Please enter a valid web address."), never a regex.
 *  - A field the server rejects (`error.fields.field_errors`) is marked inline.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import messages from '@/i18n/messages/en.json';
import { URL_PATTERN } from '@aggregator-dpg/network-config/uri-fields';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

vi.mock('@/hooks/useAggregatorConfig', () => ({
  useAggregatorConfig: () => ({
    data: {
      brand: { short_name: 'Blue Dots', primary_color: '#2563EB' },
      domains: [{ id: 'seeker', label: 'Seeker' }],
    },
    isError: false,
  }),
  DEFAULT_AGGREGATOR_CONFIG: { brand: { short_name: 'Blue Dots' }, domains: [] },
}));

import {
  PublicRegistrationView,
  readableFormErrors,
  toErrorSchema,
} from '@/app/[org]/[slug]/PublicRegistrationView';

/** The schema as the API serves it: link fields already carry the URL rule. */
const SCHEMA = {
  type: 'object',
  required: ['name', 'phone'],
  properties: {
    name: { type: 'string', title: 'Name' },
    phone: { type: 'string', title: 'Mobile' },
    website: { type: 'string', title: 'Website', 'x-uri': true, pattern: URL_PATTERN },
  },
};

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages as Record<string, unknown>}>
        <PublicRegistrationView
          org="acme"
          slug="winter25"
          domain="seeker"
          context={{ title: 'Winter 2025 Registration', org_name: 'Acme' }}
          schema={SCHEMA}
          uiSchema={{}}
          identity={{ name: 'name', phone: 'phone' }}
          submissionShape="account_and_profile"
          publicHintI18nKey={null}
          consentContent={null}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

function fill(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const submitButton = () =>
  screen.getByRole('button', { name: messages.profile.public_reg.btn_submit });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<PublicRegistrationView /> field errors (#903)', () => {
  it('keeps Submit enabled and, on click, shows which field is wrong and why', async () => {
    renderView();
    fill(/Name/, 'Asha');
    fill(/Mobile/, '9876543210');
    fill(/Website/, 'NA');

    expect(submitButton()).toBeEnabled();
    fireEvent.click(submitButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Website: Please enter a valid web address.');
    // Inline, under the field itself — not only in the banner. (The top error
    // list is hidden by globals.css, which jsdom does not apply.)
    expect(document.getElementById('root_website__error')).toHaveTextContent(
      'Please enter a valid web address.',
    );
    expect(document.body.textContent).not.toContain('must match pattern');
  });

  it('marks the field the server rejected', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'SCHEMA_VALIDATION',
              title: 'Invalid input',
              detail: 'Website: Please enter a valid web address.',
              fields: { field_errors: { website: 'Please enter a valid web address.' } },
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderView();
    fill(/Name/, 'Asha');
    fill(/Mobile/, '9876543210');
    fill(/Website/, 'www.example.org');

    fireEvent.click(submitButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() =>
      expect(document.getElementById('root_website__error')).toHaveTextContent(
        'Please enter a valid web address.',
      ),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Website: Please enter a valid web address.',
    );
  });
});

describe('readableFormErrors', () => {
  it('labels a required error with the field title, without doubling the key', () => {
    const [e] = readableFormErrors(
      [
        {
          name: 'required',
          property: '.phone',
          params: { missingProperty: 'phone' },
          message: "must have required property 'phone'",
          stack: "must have required property 'phone'",
          schemaPath: '#/required',
        },
      ],
      SCHEMA,
    );
    expect(e).toMatchObject({ message: 'is required', stack: 'Mobile: is required.' });
  });

  it('keeps ajv wording for keywords without a rewrite', () => {
    const [e] = readableFormErrors(
      [{ name: 'type', property: '.name', params: {}, message: 'must be string', stack: 'x' }],
      SCHEMA,
    );
    expect(e).toMatchObject({ message: 'must be string', stack: 'Name: must be string.' });
  });
});

describe('toErrorSchema', () => {
  it('nests dotted paths and collects messages per field', () => {
    expect(toErrorSchema({ website: 'bad', 'address.city': 'is required' })).toEqual({
      website: { __errors: ['bad'] },
      address: { city: { __errors: ['is required'] } },
    });
  });

  it('never writes through __proto__, and keeps fields named like Object members', () => {
    const fromServer = JSON.parse(
      '{"__proto__.polluted":"x","constructor.prototype":"y","toString":"z"}',
    ) as Record<string, unknown>;
    const schema = toErrorSchema(fromServer)!;
    expect('polluted' in schema).toBe(false);
    expect(Object.getPrototypeOf(schema)).toBe(Object.prototype);
    expect(schema).toEqual({
      constructor: { prototype: { __errors: ['y'] } },
      toString: { __errors: ['z'] },
    });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['__errors']).toBeUndefined();
  });

  it('returns undefined when there is nothing usable to mark', () => {
    expect(toErrorSchema(undefined)).toBeUndefined();
    expect(toErrorSchema(['x'])).toBeUndefined();
    expect(toErrorSchema({ website: 42 })).toBeUndefined();
  });
});
