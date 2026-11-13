/**
 * View test: <ProfileFormView /> — read-only aggregator profile (issue #470).
 *
 * Per CLAUDE.md's dual-mode schema-rendering note, `/profile` renders the
 * SAME `registration.v1` schema `/register` renders, but read-only (RJSF's
 * `readonly` prop) via a locally-built `readonlyUiSchema`, and drives a
 * "Request an update" panel off `x-updatable` schema fields. This suite
 * mocks `RjsfThemedForm` to inspect the props ProfileFormView passes it
 * (readonly, hidden consent, suppressed submit button) rather than
 * re-testing RJSF's own rendering, and covers the loading/error profile
 * states plus the update-request panel's UI-only "coming soon" flow.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { RJSFSchema } from '@rjsf/utils';
import messages from '@/i18n/messages/en.json';
import { ThemeModeProvider } from '@/lib/theme-mode';

const { useProfileRaw } = vi.hoisted(() => ({ useProfileRaw: vi.fn() }));
vi.mock('@/hooks/useProfile', () => ({ useProfileRaw }));

let lastRjsfProps: Record<string, unknown> | undefined;
vi.mock('@/components/forms/RjsfThemed', () => ({
  RjsfThemedForm: (props: Record<string, unknown>) => {
    lastRjsfProps = props;
    return <div data-testid="rjsf-readonly" />;
  },
}));

import { ProfileFormView } from '@/app/(protected)/profile/ProfileFormView';

const schema: RJSFSchema = {
  title: 'Aggregator Registration',
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Organisation Name', 'x-updatable': true },
    type: { type: 'string', title: 'Type' },
    url: { type: 'string', title: 'Website', 'x-updatable': true },
  },
};

const uiSchema = { consent: { 'ui:widget': 'ConsentCheckboxWidget' } };

const apiResponse = {
  aggregator_id: 'agg-1',
  org_slug: 'acme',
  org_name: 'Acme Org',
  actor_type: 'aggregator' as const,
  type: 'seeker',
  url: 'https://acme.example',
  contact: { name: 'Jane', phone: '9876543210', email: 'jane@acme.example' },
  locations: [
    {
      geo: { type: 'Point' },
      address: {
        streetAddress: '123 Main St',
        addressLocality: 'Bengaluru',
        addressRegion: 'KA',
        postalCode: '560001',
        addressCountry: 'IN',
      },
    },
  ],
  consent: { value: true, given_at: '2024-01-01T00:00:00Z', valid_till: '2025-01-01T00:00:00Z' },
  status: 'active' as const,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

function renderView() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ThemeModeProvider>
        <ProfileFormView schema={schema} uiSchema={uiSchema} />
      </ThemeModeProvider>
    </NextIntlClientProvider>,
  );
}

describe('<ProfileFormView />', () => {
  beforeEach(() => {
    lastRjsfProps = undefined;
    useProfileRaw.mockReset();
  });

  it('shows a loading state while the profile query is in flight', () => {
    useProfileRaw.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    renderView();
    expect(screen.getByText(messages.profile.view.loading)).toBeInTheDocument();
  });

  it('shows an error state when the profile query fails', () => {
    useProfileRaw.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderView();
    expect(screen.getByText(messages.profile.view.error_load_title)).toBeInTheDocument();
    expect(screen.getByText(messages.profile.view.error_load_detail)).toBeInTheDocument();
  });

  it('renders the form read-only with the consent block hidden and submit suppressed', () => {
    useProfileRaw.mockReturnValue({ data: apiResponse, isLoading: false, isError: false });
    renderView();
    expect(screen.getByTestId('rjsf-readonly')).toBeInTheDocument();
    expect(lastRjsfProps?.readonly).toBe(true);
    const readonlyUi = lastRjsfProps?.uiSchema as Record<string, unknown>;
    expect(readonlyUi['ui:submitButtonOptions']).toEqual({ norender: true });
    expect((readonlyUi['consent'] as Record<string, unknown>)['ui:widget']).toBe('hidden');
    // The registration-only title/description are stripped for the display schema.
    expect((lastRjsfProps?.schema as RJSFSchema).title).toBeUndefined();
  });

  it('maps the API response into registration-schema-shaped form data', () => {
    useProfileRaw.mockReturnValue({ data: apiResponse, isLoading: false, isError: false });
    renderView();
    const formData = lastRjsfProps?.formData as Record<string, unknown>;
    expect(formData['name']).toBe('Acme Org');
    expect(formData['type']).toBe('seeker');
    expect(formData['url']).toBe('https://acme.example');
    expect(formData['locations']).toEqual(apiResponse.locations);
  });

  it('opens the "Request an update" panel listing each x-updatable field with its current value', () => {
    useProfileRaw.mockReturnValue({ data: apiResponse, isLoading: false, isError: false });
    renderView();
    fireEvent.click(screen.getByText(messages.profile.view.btn_request_update));
    expect(screen.getByText(messages.profile.view.update_request_heading)).toBeInTheDocument();
    // Only x-updatable fields (name, url) appear — not "type".
    expect(screen.getByText('Organisation Name')).toBeInTheDocument();
    expect(screen.getByText('Website')).toBeInTheDocument();
    expect(screen.queryByText('Type')).toBeNull();
    // `currentValueFor` reads the field key straight off the API response —
    // `url` matches a top-level field so its value renders; `name` has no
    // same-named API field (the API exposes `org_name`), so it falls back to
    // the em-dash placeholder.
    expect(screen.getByText('https://acme.example')).toBeInTheDocument();
  });

  it('gates the submit button on at least one entered new value, then shows the pending banner', () => {
    useProfileRaw.mockReturnValue({ data: apiResponse, isLoading: false, isError: false });
    renderView();
    fireEvent.click(screen.getByText(messages.profile.view.btn_request_update));
    const submitBtn = screen.getByText(messages.profile.view.btn_submit_request);
    expect(submitBtn).toBeDisabled();

    const inputs = screen.getAllByPlaceholderText(messages.profile.view.new_value_placeholder);
    fireEvent.change(inputs[0]!, { target: { value: 'New Org Name' } });
    expect(submitBtn).toBeEnabled();

    fireEvent.click(submitBtn);
    expect(screen.getByText(messages.profile.view.update_request_pending)).toBeInTheDocument();
    expect(submitBtn).toBeDisabled();
  });

  it('re-arms the pending banner off when a new value changes after submitting', () => {
    useProfileRaw.mockReturnValue({ data: apiResponse, isLoading: false, isError: false });
    renderView();
    fireEvent.click(screen.getByText(messages.profile.view.btn_request_update));
    const inputs = screen.getAllByPlaceholderText(messages.profile.view.new_value_placeholder);
    fireEvent.change(inputs[0]!, { target: { value: 'New Org Name' } });
    fireEvent.click(screen.getByText(messages.profile.view.btn_submit_request));
    expect(screen.getByText(messages.profile.view.update_request_pending)).toBeInTheDocument();

    fireEvent.change(inputs[0]!, { target: { value: 'Another Name' } });
    expect(screen.queryByText(messages.profile.view.update_request_pending)).toBeNull();
  });

  it('closes and resets the panel on Cancel', () => {
    useProfileRaw.mockReturnValue({ data: apiResponse, isLoading: false, isError: false });
    renderView();
    fireEvent.click(screen.getByText(messages.profile.view.btn_request_update));
    const inputs = screen.getAllByPlaceholderText(messages.profile.view.new_value_placeholder);
    fireEvent.change(inputs[0]!, { target: { value: 'New Org Name' } });
    fireEvent.click(screen.getByText(messages.profile.view.btn_cancel));
    expect(screen.queryByText(messages.profile.view.update_request_heading)).toBeNull();

    // Re-opening starts fresh — the previously entered value is gone.
    fireEvent.click(screen.getByText(messages.profile.view.btn_request_update));
    const freshInputs = screen.getAllByPlaceholderText(messages.profile.view.new_value_placeholder);
    expect((freshInputs[0] as HTMLInputElement).value).toBe('');
  });

  it('shows the empty-state copy when the schema declares no x-updatable fields', () => {
    useProfileRaw.mockReturnValue({ data: apiResponse, isLoading: false, isError: false });
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ThemeModeProvider>
          <ProfileFormView
            schema={{ type: 'object', properties: { name: { type: 'string' } } }}
            uiSchema={{}}
          />
        </ThemeModeProvider>
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByText(messages.profile.view.btn_request_update));
    expect(screen.getByText(messages.profile.view.update_request_empty)).toBeInTheDocument();
  });

  it('flattens the first location into a single postal-address line for an x-updatable `locations` field', () => {
    useProfileRaw.mockReturnValue({ data: apiResponse, isLoading: false, isError: false });
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ThemeModeProvider>
          <ProfileFormView
            schema={{
              type: 'object',
              properties: { locations: { type: 'array', title: 'Address', 'x-updatable': true } },
            }}
            uiSchema={{}}
          />
        </ThemeModeProvider>
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByText(messages.profile.view.btn_request_update));
    expect(screen.getByText('123 Main St, Bengaluru, KA, 560001, IN')).toBeInTheDocument();
  });

  it('renders an em-dash for a `locations` x-updatable field when no location is on file', () => {
    useProfileRaw.mockReturnValue({
      data: { ...apiResponse, locations: [] },
      isLoading: false,
      isError: false,
    });
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ThemeModeProvider>
          <ProfileFormView
            schema={{
              type: 'object',
              properties: { locations: { type: 'array', title: 'Address', 'x-updatable': true } },
            }}
            uiSchema={{}}
          />
        </ThemeModeProvider>
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByText(messages.profile.view.btn_request_update));
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders an em-dash for every updatable field with no matching API value', () => {
    useProfileRaw.mockReturnValue({
      data: { ...apiResponse, url: null },
      isLoading: false,
      isError: false,
    });
    renderView();
    fireEvent.click(screen.getByText(messages.profile.view.btn_request_update));
    // `name` (no matching API field) and `url` (explicitly null) both render
    // the em-dash placeholder.
    expect(screen.getAllByText('—')).toHaveLength(2);
  });
});
