/**
 * Unit tests for SupportDialog.
 *
 * Covers: the whitespace-only-message submit guard (no network call), the
 * happy-path POST + inline success message, and the inline "unavailable"
 * notice shown when the BFF responds 503 (SUPPORT_EMAIL not configured).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { SupportDialog } from '@/components/support/SupportDialog';

function renderDialog() {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SupportDialog open onOpenChange={() => {}} />
    </NextIntlClientProvider>,
  );
}

describe('SupportDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does not submit when the message is empty/whitespace', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    renderDialog();
    await userEvent.type(screen.getByLabelText(/message/i), '   ');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText(/please enter a message/i)).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to /api/support and shows success', async () => {
    const fetchSpy = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 201 }));
    renderDialog();
    await userEvent.type(screen.getByLabelText(/message/i), 'It broke');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/support',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(await screen.findByText(/message sent/i)).toBeTruthy();
  });

  it('shows the unavailable message on 503', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
    renderDialog();
    await userEvent.type(screen.getByLabelText(/message/i), 'hi');
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText(/isn't available|unavailable/i)).toBeTruthy();
  });
});
