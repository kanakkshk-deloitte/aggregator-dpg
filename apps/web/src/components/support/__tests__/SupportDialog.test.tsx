/**
 * Unit tests for SupportDialog.
 *
 * Covers: prefill from the session user, the submit gating (details + at
 * least one contact + consent) that blocks a network call, the happy-path
 * POST + inline success message, and the inline "unavailable" notice shown
 * when the BFF responds 503 (SUPPORT_EMAIL not configured).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { SupportDialog } from '@/components/support/SupportDialog';
import { AuthProvider } from '@/lib/auth-context';
import type { User } from '@/types';

const prefilledUser: User = {
  id: 'u1',
  name: 'Asha K',
  org: 'asha@example.com',
  email: 'asha@example.com',
  phone: '+919000000000',
};

function renderDialog(user: User | null = prefilledUser) {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AuthProvider initialUser={user} supportEnabled>
        <SupportDialog open onOpenChange={() => {}} />
      </AuthProvider>
    </NextIntlClientProvider>,
  );
}

describe('SupportDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('prefills name/email/phone from the session user', () => {
    renderDialog();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Asha K');
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('asha@example.com');
    expect((screen.getByLabelText('Phone') as HTMLInputElement).value).toBe('+919000000000');
  });

  it('does not submit until details + a contact + consent are provided', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    renderDialog();
    // Contact is prefilled, but details + consent are missing → send blocked.
    await userEvent.type(screen.getByLabelText('Details'), 'It broke');
    const send = screen.getByRole('button', { name: /send/i });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(send);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs the full body to /api/support and shows success', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 201 }));
    renderDialog();
    await userEvent.type(screen.getByLabelText('Details'), 'It broke');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/support');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      name: 'Asha K',
      email: 'asha@example.com',
      phone: '+919000000000',
      type: 'complaint',
      details: 'It broke',
      consent: true,
    });
    expect(await screen.findByText(/message sent/i)).toBeTruthy();
  });

  it('shows the unavailable message on 503', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
    renderDialog();
    await userEvent.type(screen.getByLabelText('Details'), 'hi');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText(/isn't available|unavailable/i)).toBeTruthy();
  });
});
