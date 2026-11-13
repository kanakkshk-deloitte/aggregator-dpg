/**
 * View test: <OwnerInviteView /> — the org-owner invite surface (#701).
 *
 * Covers the Name+Email rows + "Add another" bulk mint (summary render), the
 * expired-grant recovery banner, invalid-grant, rate-limit, network error, and
 * the invalid-row list. `fetch` is stubbed per case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { fillTerms } from '@/i18n/terms';

vi.mock('@/hooks/useAggregatorConfig', () => {
  const cfg = { brand: { short_name: 'Test Aggregator' } };
  return {
    useAggregatorConfig: () => ({ data: cfg, isLoading: false }),
    DEFAULT_AGGREGATOR_CONFIG: cfg,
  };
});

import { OwnerInviteView } from '@/app/(public)/register/invite/OwnerInviteView';

const term = (key: string): string => fillTerms(`[[${key}]]`, 'en');

function renderView() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OwnerInviteView grant="grant-jwt" />
    </NextIntlClientProvider>,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** Fills the email field of row `idx` (default first). */
function typeEmail(value: string, idx = 0): void {
  fireEvent.change(screen.getAllByPlaceholderText('email@org.in')[idx]!, { target: { value } });
}
function clickSend(): void {
  fireEvent.click(screen.getByRole('button', { name: /send/i }));
}

describe('<OwnerInviteView />', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.clearAllMocks());

  it('mints invites from Name+Email rows and renders the summary', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { recovered: false, sent: 2, resent: 0, invalid: [] }));
    vi.stubGlobal('fetch', fetchMock);

    renderView();
    typeEmail('a@x.org');
    fireEvent.click(screen.getByRole('button', { name: /add another/i }));
    typeEmail('b@x.org', 1);
    fireEvent.change(screen.getAllByPlaceholderText('Name (optional)')[1]!, {
      target: { value: 'Bee' },
    });
    clickSend();

    await waitFor(() => expect(screen.getByText(/2 invites sent/)).toBeInTheDocument());
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(opts.body)) as { grant: string; recipients: unknown[] };
    expect(body.grant).toBe('grant-jwt');
    expect(body.recipients).toEqual([{ email: 'a@x.org' }, { email: 'b@x.org', name: 'Bee' }]);
  });

  it('removes a row with the × control', async () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /add another/i }));
    expect(screen.getAllByPlaceholderText('email@org.in')).toHaveLength(2);
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(`remove ${term('user')} 2`, 'i') }),
    );
    expect(screen.getAllByPlaceholderText('email@org.in')).toHaveLength(1);
  });

  it('shows the recovery banner when an expired grant re-mails a fresh link (recovered:true)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { recovered: true, sent: 0, resent: 0, invalid: [] })),
    );
    renderView();
    typeEmail('a@x.org');
    clickSend();
    await waitFor(() => expect(screen.getByText(/had expired/i)).toBeInTheDocument());
  });

  it('shows an invalid-grant banner on GRANT_INVALID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(400, { error: { code: 'GRANT_INVALID' } })),
    );
    renderView();
    typeEmail('a@x.org');
    clickSend();
    await waitFor(() => expect(screen.getByText(/not valid/i)).toBeInTheDocument());
  });

  it('shows a rate-limit message on 429', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(429, {})));
    renderView();
    typeEmail('a@x.org');
    clickSend();
    await waitFor(() => expect(screen.getByText(/too many invites/i)).toBeInTheDocument());
  });

  it('shows a network-error message when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    renderView();
    typeEmail('a@x.org');
    clickSend();
    await waitFor(() => expect(screen.getByText(/network error/i)).toBeInTheDocument());
  });

  it('lists invalid rows in the result summary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          recovered: false,
          sent: 1,
          resent: 0,
          invalid: [{ email: 'bad', reason: 'invalid_email' }],
        }),
      ),
    );
    renderView();
    typeEmail('a@x.org');
    clickSend();
    await waitFor(() => expect(screen.getByText(/couldn.t be invited/i)).toBeInTheDocument());
    expect(screen.getByText(/bad — invalid email/i)).toBeInTheDocument();
  });
});
