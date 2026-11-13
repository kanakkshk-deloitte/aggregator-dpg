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

/** The attachment limits the dialog fetches on open (#551). */
const SUPPORT_CONFIG = {
  enabled: true,
  maxTotalBytes: 5 * 1024 * 1024,
  maxFiles: 3,
  allowedTypes: ['image/png', 'image/jpeg', 'audio/mpeg'],
};

/**
 * Spies on fetch, answering `GET /api/support/config` with the limits above and
 * every submit with `submitResponse`. The dialog issues two different requests,
 * so a single blanket mock would answer the config call with a submit response.
 */
function mockFetch(submitResponse: Response | (() => Response)) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
    if (String(url).includes('/api/support/config')) {
      return new Response(JSON.stringify(SUPPORT_CONFIG), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return typeof submitResponse === 'function' ? submitResponse() : submitResponse;
  });
}

type FetchSpy = ReturnType<typeof mockFetch>;

/** POST calls to /api/support, ignoring the config GET. */
function submitCalls(spy: FetchSpy) {
  return spy.mock.calls.filter(
    ([url, init]) =>
      String(url) === '/api/support' && (init as RequestInit | undefined)?.method === 'POST',
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
    const fetchSpy = mockFetch(new Response('{"ok":true}', { status: 201 }));
    renderDialog();
    // Contact is prefilled, but details + consent are missing → send blocked.
    await userEvent.type(screen.getByLabelText('Details'), 'It broke');
    const send = screen.getByRole('button', { name: /send/i });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(send);
    // The dialog does fetch its attachment config on open, so assert on the
    // absence of a submit rather than the absence of any request.
    expect(submitCalls(fetchSpy)).toHaveLength(0);
  });

  it('POSTs the full body to /api/support and shows success', async () => {
    const fetchSpy = mockFetch(new Response('{"ok":true}', { status: 201 }));
    renderDialog();
    await userEvent.type(screen.getByLabelText('Details'), 'It broke');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(submitCalls(fetchSpy)).toHaveLength(1));
    const [url, init] = submitCalls(fetchSpy)[0]!;
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
    mockFetch(new Response('{}', { status: 503 }));
    renderDialog();
    await userEvent.type(screen.getByLabelText('Details'), 'hi');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText(/isn't available|unavailable/i)).toBeTruthy();
  });
});

describe('SupportDialog attachments (#551)', () => {
  const file = (name: string, type: string, bytes = 64) =>
    new File([new Uint8Array(bytes)], name, { type });

  const fillRequired = async () => {
    await userEvent.type(screen.getByLabelText('Details'), 'It broke');
    await userEvent.click(screen.getByRole('checkbox'));
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the limits served by the API', async () => {
    mockFetch(new Response('{"ok":true}', { status: 201 }));
    renderDialog();
    expect(await screen.findByText(/Up to 3 files, 5.0 MB in total/)).toBeTruthy();
  });

  it('lists a chosen file and submits it base64-encoded', async () => {
    const fetchSpy = mockFetch(new Response('{"ok":true}', { status: 201 }));
    renderDialog();
    await waitFor(() => expect(screen.getByText(/Up to 3 files/)).toBeTruthy());
    await userEvent.upload(screen.getByLabelText('Attachments (optional)'), [
      file('evidence.png', 'image/png', 1024),
    ]);
    expect(screen.getByText('evidence.png')).toBeTruthy();
    expect(screen.getByText('1.0 KB')).toBeTruthy();

    await fillRequired();
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(submitCalls(fetchSpy)).toHaveLength(1));
    const body = JSON.parse((submitCalls(fetchSpy)[0]![1] as RequestInit).body as string);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({
      filename: 'evidence.png',
      contentType: 'image/png',
    });
    // 1024 zero bytes base64-encode to 1368 characters.
    expect(body.attachments[0].data).toHaveLength(1368);
  });

  it('omits attachments from the body when none are chosen', async () => {
    const fetchSpy = mockFetch(new Response('{"ok":true}', { status: 201 }));
    renderDialog();
    await fillRequired();
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(submitCalls(fetchSpy)).toHaveLength(1));
    const body = JSON.parse((submitCalls(fetchSpy)[0]![1] as RequestInit).body as string);
    expect(body.attachments).toBeUndefined();
  });

  it('removes a chosen file', async () => {
    mockFetch(new Response('{"ok":true}', { status: 201 }));
    renderDialog();
    await waitFor(() => expect(screen.getByText(/Up to 3 files/)).toBeTruthy());
    await userEvent.upload(screen.getByLabelText('Attachments (optional)'), [
      file('a.png', 'image/png'),
    ]);
    await userEvent.click(screen.getByRole('button', { name: /Remove a.png/i }));
    expect(screen.queryByText('a.png')).toBeNull();
  });

  it('refuses a selection over the total size budget', async () => {
    mockFetch(new Response('{"ok":true}', { status: 201 }));
    renderDialog();
    await waitFor(() => expect(screen.getByText(/Up to 3 files/)).toBeTruthy());
    // Declared size only — no reason to allocate 6MB in the test process.
    const oversized = file('big.png', 'image/png', 0);
    Object.defineProperty(oversized, 'size', { value: 6 * 1024 * 1024 });
    await userEvent.upload(screen.getByLabelText('Attachments (optional)'), [oversized]);
    expect(await screen.findByText(/must total no more than 5.0 MB/i)).toBeTruthy();
    expect(screen.queryByText('big.png')).toBeNull();
  });

  it('refuses more files than the served maximum', async () => {
    mockFetch(new Response('{"ok":true}', { status: 201 }));
    renderDialog();
    await waitFor(() => expect(screen.getByText(/Up to 3 files/)).toBeTruthy());
    await userEvent.upload(screen.getByLabelText('Attachments (optional)'), [
      file('a.png', 'image/png'),
      file('b.png', 'image/png'),
      file('c.png', 'image/png'),
      file('d.png', 'image/png'),
    ]);
    expect(await screen.findByText(/at most 3 files/i)).toBeTruthy();
    expect(screen.queryByText('a.png')).toBeNull();
  });

  it('surfaces a server-side attachment rejection, which names the file', async () => {
    mockFetch(
      new Response(
        JSON.stringify({
          error: {
            code: 'ATTACHMENT_TYPE_NOT_ALLOWED',
            detail: 'run.exe is not an accepted file type.',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    renderDialog();
    await fillRequired();
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText(/run.exe is not an accepted file type/i)).toBeTruthy();
  });

  it('explains a 429 as a rate limit', async () => {
    mockFetch(new Response('{}', { status: 429 }));
    renderDialog();
    await fillRequired();
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText(/several messages recently/i)).toBeTruthy();
  });

  it('treats a 413 as an over-size attachment rather than a generic failure', async () => {
    mockFetch(new Response('{}', { status: 413 }));
    renderDialog();
    await fillRequired();
    await userEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText(/must total no more than 5.0 MB/i)).toBeTruthy();
  });
});
