/**
 * View test: <OrgRegisterForm /> with the REAL RJSF form and the repository's
 * default org-registration schema (website, GST number, domains).
 *
 * Submit is never disabled by a bad field: a click runs the form's checks and
 * shows each field's own message (from the schema, never a regex), and
 * nothing is sent. The address block is dropped from the schema here; its
 * autocomplete widget needs map configuration this test does not cover.
 *
 * @module apps/web/src/__tests__/views/OrgRegisterForm.schema-fields.test.tsx
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RJSFSchema } from '@rjsf/utils';
import messages from '@/i18n/messages/en.json';
import { applyNetworkDomains } from '@/lib/org-schema';
import defaultSchema from '../../../../../config/schemas/aggregator/org-registration.v1.json';
import defaultUi from '../../../../../config/schemas/aggregator/org-registration.v1.ui.json';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

const gateOpened = vi.fn();
vi.mock('@/components/consent/ConsentGate', () => ({
  ConsentGate: (props: { open: boolean }) => {
    if (props.open) gateOpened();
    return null;
  },
}));

import { OrgRegisterForm } from '@/app/(public)/register/OrgRegisterForm';

/** The default schema without its address block, domains filled in. */
function schemaUnderTest() {
  const schema = structuredClone(defaultSchema) as unknown as Record<string, unknown>;
  delete (schema['properties'] as Record<string, unknown>)['address'];
  const ui = structuredClone(defaultUi) as Record<string, unknown>;
  ui['ui:order'] = (ui['ui:order'] as string[]).filter((k) => k !== 'address');
  delete ui['address'];
  return applyNetworkDomains(schema as unknown as RJSFSchema, ui, [
    { id: 'seeker', label: 'Seekers' },
    { id: 'provider', label: 'Providers' },
  ]);
}

const CONSENT = {
  terms: { version: 1, title: 'Terms of Service', content: 'Terms body' },
  privacy: { version: 1, title: 'Privacy Policy', content: 'Privacy body' },
};

function renderForm() {
  const { schema, uiSchema } = schemaUnderTest();
  // The parent picker's list, as the page loads it: only the root, so no picker shows.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['org-parents'], {
    accepting: true,
    parents: [
      {
        id: 'p-root',
        name: 'Blue Dots',
        is_root: true,
        known_as_name: null,
        child_known_as_name: 'Aggregator',
      },
    ],
  });
  render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <OrgRegisterForm schema={schema} uiSchema={uiSchema} consentContent={CONSENT} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

/** Fills the required fields with valid values. */
function fillRequired() {
  fireEvent.change(screen.getByLabelText(/Organisation Name/), {
    target: { value: 'Enable India' },
  });
  fireEvent.change(screen.getByLabelText(/Owner Name/), { target: { value: 'Rajesh Kumar' } });
  fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'owner@enable.org' } });
}

const submitButton = () => screen.getByRole('button', { name: messages.register.org_submit });

afterEach(() => {
  gateOpened.mockClear();
});

describe('<OrgRegisterForm /> schema fields', () => {
  it('shows website, GST number and domains from the schema', () => {
    renderForm();
    expect(screen.getByLabelText(/Website/)).toBeInTheDocument();
    expect(screen.getByLabelText(/GST number/)).toBeInTheDocument();
    expect(screen.getByText('Domains')).toBeInTheDocument();
  });

  it('keeps Submit enabled while a field is wrong', () => {
    renderForm();
    fillRequired();
    fireEvent.change(screen.getByLabelText(/Website/), {
      target: { value: 'http://enable.org' },
    });
    expect(submitButton()).not.toBeDisabled();
  });

  it('on Submit, shows the website message from the schema and sends nothing', async () => {
    renderForm();
    fillRequired();
    fireEvent.change(screen.getByLabelText(/Website/), { target: { value: 'enable.org' } });
    fireEvent.click(submitButton());
    expect(
      (await screen.findAllByText(/Please enter a website starting with https:\/\//)).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/\^https/)).toBeNull();
    expect(gateOpened).not.toHaveBeenCalled();
  });

  it('on Submit, refuses a GSTIN with a wrong check character', async () => {
    renderForm();
    fillRequired();
    fireEvent.change(screen.getByLabelText(/GST number/), {
      target: { value: '29ABCDE1234F1Z5' },
    });
    fireEvent.click(submitButton());
    expect((await screen.findAllByText(/Please enter a valid GSTIN\./)).length).toBeGreaterThan(0);
    expect(gateOpened).not.toHaveBeenCalled();
  });

  it('opens the consent step once every field is valid', async () => {
    renderForm();
    fillRequired();
    fireEvent.change(screen.getByLabelText(/Website/), {
      target: { value: 'https://enable.org' },
    });
    fireEvent.change(screen.getByLabelText(/GST number/), {
      target: { value: '29ABCDE1234F1ZW' },
    });
    fireEvent.click(submitButton());
    await waitFor(() => expect(gateOpened).toHaveBeenCalled());
  });
});
