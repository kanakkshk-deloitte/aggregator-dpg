/**
 * View test: <MinimalIdentityForm /> — identity-only capture for
 * `submission_shape === 'account_only'` public links.
 *
 * Covers: field visibility driven by the `identity` selector map, the
 * name+contact+year-of-birth+consent validity gate (including the voice-mode
 * required-phone variant), the U18 no-consent branch, and the submit payload
 * shape. The form's own terms/privacy line + `ConsentModal` were removed in
 * #636 Task 8 — that consent now runs through the parent
 * (`PublicRegistrationView`)'s blocking gate; see
 * `PublicRegistrationView.account-only-consent-gate.test.tsx` and
 * `.account-only-consent-submit.test.tsx`. `consentCall` (the call-permission
 * checkbox covered below) is a distinct consent this form still owns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';

import { MinimalIdentityForm } from '@/app/[org]/[slug]/MinimalIdentityForm';

const currentYear = new Date().getFullYear();
const validYear = String(currentYear - 25);
const minorYear = String(currentYear - 10);

function renderForm(props: Partial<React.ComponentProps<typeof MinimalIdentityForm>> = {}) {
  const onSubmit = props.onSubmit ?? vi.fn();
  const utils = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MinimalIdentityForm
        identity={{ name: 'name', phone: 'phone', email: 'email' }}
        onSubmit={onSubmit}
        showConsent
        showBirthYear
        {...props}
      />
    </NextIntlClientProvider>,
  );
  return { ...utils, onSubmit };
}

function fillCommon(getByLabel: (l: string | RegExp) => HTMLElement) {
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane Doe' } });
  fireEvent.change(screen.getByLabelText(/Year of birth/), { target: { value: validYear } });
  void getByLabel;
}

describe('<MinimalIdentityForm />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders phone and email fields when both identity selectors are present', () => {
    renderForm();
    expect(screen.getByLabelText(/Phone/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Email/)).toBeInTheDocument();
  });

  it('hides the phone field when identity.phone is not declared', () => {
    renderForm({ identity: { name: 'name', email: 'email' } });
    expect(screen.queryByLabelText(/^Phone/)).toBeNull();
  });

  it('hides the email field when identity.email is not declared', () => {
    renderForm({ identity: { name: 'name', phone: 'phone' } });
    expect(screen.queryByLabelText(/^Email/)).toBeNull();
  });

  it('disables submit and lists blockers before anything is filled', () => {
    renderForm();
    expect(
      screen.getByRole('button', { name: messages.profile.public_reg.account_only.submit_label }),
    ).toBeDisabled();
    expect(
      screen.getByText(messages.profile.public_reg.account_only.blockers.name),
    ).toBeInTheDocument();
  });

  it('flags an invalid phone number as a blocker', () => {
    renderForm();
    fillCommon(screen.getByLabelText.bind(screen));
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '123' } });
    expect(
      screen.getByText(messages.profile.public_reg.account_only.blockers.phone_invalid),
    ).toBeInTheDocument();
  });

  it('flags an invalid email as a blocker when entered', () => {
    renderForm();
    fillCommon(screen.getByLabelText.bind(screen));
    fireEvent.change(screen.getByLabelText(/Email/), { target: { value: 'not-an-email' } });
    expect(
      screen.getByText(messages.profile.public_reg.account_only.blockers.email_invalid),
    ).toBeInTheDocument();
  });

  it('enables submit once name + valid phone + year of birth + consent are set', () => {
    renderForm();
    fillCommon(screen.getByLabelText.bind(screen));
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(
      screen.getByRole('button', { name: messages.profile.public_reg.account_only.submit_label }),
    ).toBeEnabled();
  });

  it('submits the identity payload with the network field keys on click', () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    fillCommon(screen.getByLabelText.bind(screen));
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(
      screen.getByRole('button', { name: messages.profile.public_reg.account_only.submit_label }),
    );
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Jane Doe',
        phone: '9876543210',
        year_of_birth: validYear,
      }),
    );
    // #636 Task 8: consent_terms/consent_privacy are no longer set by this
    // form — the parent view stamps them from its own blocking consent gate.
    // Leaving the call-permission checkbox's value here would have been the
    // silent-mis-record bug the task fixed (the parent used to overwrite
    // whatever this form sent with `false` anyway).
    const payload = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload['consent_terms']).toBeUndefined();
    expect(payload['consent_privacy']).toBeUndefined();
  });

  it('requires phone and hides nothing else in voice mode (requirePhone)', () => {
    renderForm({ requirePhone: true });
    expect(
      screen.getByText(messages.profile.public_reg.account_only.blockers.phone_required),
    ).toBeInTheDocument();
  });

  it('shows the U18 notice and skips consent for a minor, still allowing submit', () => {
    const onSubmit = vi.fn();
    renderForm({ onSubmit });
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Kid' } });
    fireEvent.change(screen.getByLabelText(/Year of birth/), { target: { value: minorYear } });
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    expect(
      screen.getByText(messages.profile.public_reg.account_only.u18_notice),
    ).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: messages.profile.public_reg.account_only.submit_label }),
    );
    expect(onSubmit).toHaveBeenCalled();
  });

  it('keeps the call-permission checkbox on the form (a distinct consent from the parent gate)', () => {
    renderForm();
    expect(
      screen.getByRole('checkbox', { name: /permit the aggregator to trigger the call/i }),
    ).toBeInTheDocument();
  });

  it('renders the submit button disabled while `busy` is true even when otherwise valid', () => {
    renderForm({ busy: true });
    fillCommon(screen.getByLabelText.bind(screen));
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '9876543210' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(
      screen.getByRole('button', { name: messages.profile.public_reg.account_only.submit_label }),
    ).toBeDisabled();
  });

  it('rejects an out-of-range year of birth', () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'Jane' } });
    fireEvent.change(screen.getByLabelText(/Year of birth/), {
      target: { value: String(currentYear + 5) },
    });
    expect(
      screen.getByText(messages.profile.public_reg.account_only.blockers.year_of_birth),
    ).toBeInTheDocument();
  });
});
