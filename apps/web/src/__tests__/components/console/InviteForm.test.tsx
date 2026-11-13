/**
 * Unit tests for InviteForm.
 *
 * Covers: the single-org line and the multi-org select, turning typed and
 * pasted text into chips (dedupe, invalid marking, removal), optional names,
 * the one-line result with a reason per status, invalid addresses blocking the
 * send, the per-send cap, the help panel with its
 * limits, a plain message for each kind of failure, and switching the chosen organisation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import hiMessages from '@/i18n/messages/hi.json';
import { fillTerms } from '@/i18n/terms';
import { InviteForm, parseRecipients } from '@/components/console/InviteForm';

const term = (key: string): string => fillTerms(`[[${key}]]`, 'en');

const orgs = [
  { id: 'org-1', name: 'First Org' },
  { id: 'org-2', name: 'Second Org' },
];

function renderForm(list = orgs) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <InviteForm orgs={list} />
    </NextIntlClientProvider>,
  );
}

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

const emailBox = () => screen.getByLabelText(messages.console.invite.recipients);

/** Types `text` and presses Enter, as a user adding addresses would. */
function typeAddresses(text: string) {
  fireEvent.change(emailBox(), { target: { value: text } });
  fireEvent.keyDown(emailBox(), { key: 'Enter' });
}

const sendButton = () => screen.getByRole('button', { name: /^Send/ });

describe('parseRecipients', () => {
  it('splits on commas, semicolons, spaces and new lines, lower-cases and dedupes', () => {
    const got = parseRecipients('A@x.org, b@x.org;\nb@x.org  a@x.org', []);
    expect(got.map((r) => r.email)).toEqual(['a@x.org', 'b@x.org']);
  });

  it('skips addresses already in the list and marks invalid ones', () => {
    const got = parseRecipients('a@x.org not-an-email', [
      { email: 'a@x.org', name: '', valid: true },
    ]);
    expect(got).toEqual([{ email: 'not-an-email', name: '', valid: false }]);
  });
});

describe('<InviteForm />', () => {
  const original = global.fetch;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    global.fetch = original;
  });

  it('shows the organisation as text when there is only one', () => {
    renderForm([orgs[0]!]);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText('Inviting to')).toBeInTheDocument();
    expect(screen.getByText('First Org')).toBeInTheDocument();
  });

  it('shows a select defaulting to the first organisation when there are several', () => {
    renderForm();
    expect(screen.getByRole('combobox')).toHaveValue('org-1');
    expect(screen.getByRole('option', { name: 'Second Org' })).toBeInTheDocument();
  });

  it('turns typed text into chips, flags invalid ones and lets a chip be removed', () => {
    renderForm();
    typeAddresses('a@x.org, not-an-email');
    // One remove button on the chip, one on the name row.
    expect(screen.getAllByRole('button', { name: 'Remove a@x.org' })).toHaveLength(2);
    expect(screen.getByText(/1 invalid email. Fix or remove before sending./)).toBeInTheDocument();
    expect(screen.getByText('Fix the highlighted emails to continue.')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove not-an-email' }));
    expect(screen.queryByText(/invalid email/)).not.toBeInTheDocument();
    expect(sendButton()).toHaveTextContent('Send 1 invite');
    expect(sendButton()).toBeEnabled();
  });

  it('removes every invalid address at once', () => {
    renderForm();
    typeAddresses('a@x.org bad1 bad2');
    expect(screen.getByText(/2 invalid emails/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove them' }));
    expect(screen.queryByText(/invalid email/)).not.toBeInTheDocument();
    expect(sendButton()).toHaveTextContent('Send 1 invite');
  });

  it('moves the last chip back into the box on Backspace so it can be corrected', () => {
    renderForm();
    typeAddresses('typo@x.or');
    fireEvent.keyDown(emailBox(), { key: 'Backspace' });
    expect(emailBox()).toHaveValue('typo@x.or');
    expect(screen.queryByRole('button', { name: 'Remove typo@x.or' })).not.toBeInTheDocument();
  });

  it('keeps the name when a chip is moved back into the box and added again', () => {
    renderForm();
    typeAddresses('asha@x.og');
    fireEvent.change(screen.getByLabelText('Name for asha@x.og'), { target: { value: 'Asha' } });
    fireEvent.keyDown(emailBox(), { key: 'Backspace' });
    typeAddresses('asha@x.org');
    expect(screen.getByLabelText('Name for asha@x.org')).toHaveValue('Asha');
  });

  it('keeps the name when a chip is double-clicked to fix it', () => {
    renderForm();
    typeAddresses('ravi@x.og');
    fireEvent.change(screen.getByLabelText('Name for ravi@x.og'), { target: { value: 'Ravi' } });
    // The chip comes first; the names list shows the address again.
    fireEvent.doubleClick(screen.getAllByText('ravi@x.og')[0]!);
    typeAddresses('ravi@x.org');
    expect(screen.getByLabelText('Name for ravi@x.org')).toHaveValue('Ravi');
  });

  it('drops the kept name once the box is emptied, so another address does not get it', () => {
    renderForm();
    typeAddresses('asha@x.og');
    fireEvent.change(screen.getByLabelText('Name for asha@x.og'), { target: { value: 'Asha' } });
    fireEvent.keyDown(emailBox(), { key: 'Backspace' });
    fireEvent.change(emailBox(), { target: { value: '' } });
    typeAddresses('ravi@x.org');
    expect(screen.getByLabelText('Name for ravi@x.org')).toHaveValue('');
  });

  it('asks before the page is reloaded or closed only while emails are unsent', () => {
    const unloadBlocked = () => {
      const ev = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    renderForm();
    expect(unloadBlocked()).toBe(false);
    typeAddresses('a@x.org');
    expect(unloadBlocked()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(unloadBlocked()).toBe(false);
  });

  it('asks for an address before anything is added', () => {
    renderForm();
    expect(screen.getByText('Add at least one email to continue.')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
  });

  it('adds every address in pasted text', () => {
    renderForm();
    fireEvent.paste(emailBox(), {
      clipboardData: { getData: () => 'a@x.org\nb@x.org\nc@x.org' },
    });
    expect(sendButton()).toHaveTextContent('Send 3 invites');
  });

  it('does not call the API when nothing valid was entered', () => {
    global.fetch = respond({}, 200) as never;
    renderForm();
    typeAddresses('nope');
    fireEvent.click(sendButton());
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends valid addresses with their names and shows a one-line result', async () => {
    global.fetch = respond(
      {
        sent: 2,
        resent: 1,
        invalid: [{ email: 'dup@x.org', reason: 'duplicate_in_batch' }],
        existing: [
          { email: 'known@x.org', status: 'active' },
          { email: 'gone@x.org', status: 'inactive' },
        ],
      },
      200,
    ) as never;
    renderForm();
    typeAddresses('a@x.org b@x.org');
    fireEvent.change(screen.getByLabelText('Name for a@x.org'), { target: { value: ' Asha ' } });
    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByText('3 invites sent')).toBeInTheDocument());
    const line = screen.getByText(/^Not sent:/);
    expect(line).toHaveTextContent(`known@x.org (already a ${term('user')} here)`);
    expect(line).toHaveTextContent('gone@x.org (previously rejected)');
    expect(line).toHaveTextContent('dup@x.org (listed twice)');
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/console/user/invite',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          org_id: 'org-1',
          recipients: [{ email: 'a@x.org', name: 'Asha' }, { email: 'b@x.org' }],
        }),
      }),
    );
    // The list clears for the next batch.
    expect(screen.queryByLabelText('Name for a@x.org')).not.toBeInTheDocument();
  });

  it('sends text still in the box without pressing Enter first', async () => {
    global.fetch = respond({ sent: 1, resent: 0, invalid: [], existing: [] }, 200) as never;
    renderForm();
    fireEvent.change(emailBox(), { target: { value: 'late@x.org' } });
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText('1 invite sent')).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ org_id: 'org-1', recipients: [{ email: 'late@x.org' }] }),
      }),
    );
  });

  it('explains the steps and shows the configured limits beside the form', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <InviteForm orgs={orgs} maxRecipients={5} />
      </NextIntlClientProvider>,
    );
    const help = screen.getByRole('complementary', { name: 'How it works' });
    expect(help).toHaveTextContent('You send the invite');
    expect(help).toHaveTextContent('They open the link and fill in the registration form.');
    expect(help).toHaveTextContent(
      `Review them under ${term('Users')}. Once approved, they can sign in.`,
    );
    expect(help).toHaveTextContent('Up to 5 emails per send.');
  });

  it('links to the coordinators list only when the page passes a link', () => {
    const { unmount } = renderForm();
    expect(screen.queryByRole('link', { name: term('Users') })).not.toBeInTheDocument();
    unmount();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <InviteForm orgs={orgs} coordinatorsHref="/console/coordinators" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('link', { name: term('Users') })).toHaveAttribute(
      'href',
      '/console/coordinators',
    );
  });

  it('shows the default limits when the page passes none', () => {
    renderForm();
    expect(screen.getByText('Up to 10 emails per send.')).toBeInTheDocument();
  });

  it('shows the at-a-time note when the list is exactly full, with nothing left out', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <InviteForm orgs={orgs} maxRecipients={2} />
      </NextIntlClientProvider>,
    );
    typeAddresses('a@x.org b@x.org');
    expect(screen.getByRole('status')).toHaveTextContent(
      "You've added the most you can send at once (2). Send these invites, then add more.",
    );
    expect(screen.queryByText(/not added/)).not.toBeInTheDocument();
  });

  it('renders in Hindi when the Hindi catalogue is active', () => {
    render(
      <NextIntlClientProvider locale="hi" messages={hiMessages}>
        <InviteForm orgs={[orgs[0]!]} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('complementary', { name: 'यह कैसे काम करता है' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /आमंत्रण भेजें/ })).toBeInTheDocument();
  });

  it('stops at the configured cap and says how many addresses were not added', () => {
    global.fetch = respond({}, 200) as never;
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <InviteForm orgs={orgs} maxRecipients={2} />
      </NextIntlClientProvider>,
    );
    typeAddresses('a@x.org b@x.org c@x.org d@x.org');
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      "You've added the most you can send at once (2). 2 more emails were not added. Send these invites, then add the rest.",
    );
    expect(emailBox()).toBeDisabled();
    expect(emailBox()).toHaveAttribute('placeholder', 'Limit reached');
    expect(screen.queryByRole('button', { name: 'Remove c@x.org' })).not.toBeInTheDocument();
    expect(sendButton()).toHaveTextContent('Send 2 invites');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove b@x.org' })[0]!);
    expect(emailBox()).toBeEnabled();
    expect(screen.queryByText(/not added/)).not.toBeInTheDocument();
    expect(screen.queryByText(/at once/)).not.toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('clears the previous result once the list is edited', async () => {
    global.fetch = respond({ sent: 1, resent: 0, invalid: [], existing: [] }, 200) as never;
    renderForm();
    typeAddresses('a@x.org');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText('1 invite sent')).toBeInTheDocument());
    typeAddresses('b@x.org');
    expect(screen.queryByText('1 invite sent')).not.toBeInTheDocument();
  });

  it('falls back to the API message when the API cap is lower than the form knew', async () => {
    global.fetch = respond(
      { error: { code: 'SCHEMA_VALIDATION', fields: { field: 'recipients' } } },
      400,
    ) as never;
    renderForm();
    typeAddresses('a@x.org');
    fireEvent.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(messages.console.invite.too_many);
    // The addresses stay so the user can split them.
    expect(screen.getByLabelText('Name for a@x.org')).toBeInTheDocument();
  });

  it.each([
    [500, 'server'],
    [503, 'server'],
    [400, 'invalid'],
    [401, 'signed_out'],
    [403, 'forbidden'],
    [404, 'org_unavailable'],
    [409, 'org_unavailable'],
    [429, 'rate_limited'],
    [418, 'generic'],
  ] as const)(
    'shows a plain message for a %i failure and keeps the emails',
    async (status, key) => {
      global.fetch = respond({ error: { code: 'ANY' } }, status) as never;
      renderForm();
      typeAddresses('a@x.org');
      fireEvent.click(sendButton());
      expect(await screen.findByRole('alert')).toHaveTextContent(
        messages.console.invite.error[key],
      );
      expect(screen.getByLabelText('Name for a@x.org')).toBeInTheDocument();
    },
  );

  it('says the server could not be reached when the request fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as never;
    renderForm();
    typeAddresses('a@x.org');
    fireEvent.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      messages.console.invite.error.network,
    );
  });

  it('posts to the chosen organisation after switching the select', async () => {
    global.fetch = respond({ sent: 1, resent: 0, invalid: [], existing: [] }, 200) as never;
    renderForm();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'org-2' } });
    typeAddresses('a@x.org');
    fireEvent.click(sendButton());
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ org_id: 'org-2', recipients: [{ email: 'a@x.org' }] }),
        }),
      ),
    );
  });

  it('disables sending when there are no organisations', () => {
    renderForm([]);
    expect(sendButton()).toBeDisabled();
  });
});
