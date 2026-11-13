/**
 * Unit tests for OwnerAccessRepair: re-granting an organisation's owner
 * access from its page.
 *
 * Covers: the repair call and its outcome, and an error.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { OwnerAccessRepair } from '@/components/console/OwnerAccessRepair';

const ORG = '00000000-0000-4000-8000-0000000000b2';

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

function renderIt() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OwnerAccessRepair orgId={ORG} />
    </NextIntlClientProvider>,
  );
}

describe('<OwnerAccessRepair />', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });

  it('repairs and reports the resulting owner access', async () => {
    global.fetch = respond(
      { id: ORG, status: 'granted', enable: 'ok', role: 'ok', group: 'ok' },
      200,
    ) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.orgs.repair }));
    await waitFor(() =>
      expect(
        screen.getByText(messages.console.orgs.repaired.replace('{status}', 'granted')),
      ).toBeInTheDocument(),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/org/repair/${ORG}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows a plain message when the repair fails on the server', async () => {
    global.fetch = respond({ error: { code: 'BOOM' } }, 500) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.orgs.repair }));
    expect(await screen.findByText(messages.console.errors.server)).toBeInTheDocument();
  });
});
