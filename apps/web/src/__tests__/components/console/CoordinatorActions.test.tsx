import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { User } from '@aggregator-dpg/shared-primitives/user-org';
import { CoordinatorActions } from '@/components/console/CoordinatorActions';

const user: User = {
  id: '00000000-0000-4000-8000-0000000000c1',
  user_type: 'coordinator',
  status: 'pending',
  name: 'Coordinator One',
  contact: { name: 'C1', email: 'c1@x.org', phone: null },
  serves: [],
  org_id: null,
  invited: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  rejected_at: null,
};

function renderIt(
  u: User = user,
  domains: Array<{ id: string; label: string }> = [{ id: 'seeker', label: 'Seekers' }],
  readOnly = false,
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CoordinatorActions user={u} domains={domains} readOnly={readOnly} />
    </NextIntlClientProvider>,
  );
}

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('<CoordinatorActions />', () => {
  const original = global.fetch;
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    global.fetch = original;
  });

  it('approves and shows the new status', async () => {
    global.fetch = respond({ id: user.id, status: 'active', notified: true }, 200) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    await waitFor(() =>
      expect(screen.getByTestId('coordinator-status')).toHaveTextContent(
        messages.console.status.active,
      ),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/user/decision/${user.id}`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ decision: 'approve' }) }),
    );
  });

  it('updates in place when the decision was already made elsewhere (C10)', async () => {
    global.fetch = respond(
      { error: { code: 'ALREADY_DECIDED', fields: { status: 'inactive', decided_by: 'link' } } },
      409,
    ) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    await waitFor(() =>
      expect(screen.getByTestId('coordinator-status')).toHaveTextContent(
        messages.console.status.inactive,
      ),
    );
    expect(screen.queryByRole('button', { name: messages.console.coordinator.approve })).toBeNull();
  });

  it('shows the review prompt with the name and registration date', () => {
    renderIt();
    expect(screen.getByText(messages.console.coordinator.decision_title)).toBeInTheDocument();
    expect(
      screen.getByText(
        'C1 registered on Jan 1, 2026. Approve to let them sign in, or reject the registration.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('asks for the optional reason only after Reject, and cancels back', () => {
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.reject }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: messages.console.coordinator.approve })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.cancel }));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(
      screen.getByRole('button', { name: messages.console.coordinator.approve }),
    ).toBeInTheDocument();
  });

  it('sends the optional reason with a reject', async () => {
    global.fetch = respond({ id: user.id, status: 'inactive', notified: true }, 200) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.reject }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'incomplete' } });
    fireEvent.click(
      screen.getByRole('button', { name: messages.console.coordinator.reject_confirm }),
    );
    expect(await screen.findByText(messages.console.coordinator.rejected_note)).toBeInTheDocument();
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify({ decision: 'reject', reason: 'incomplete' }),
        }),
      ),
    );
  });

  it('shows the rate-limit message on 429', async () => {
    global.fetch = respond({ error: { code: 'RATE_LIMITED' } }, 429) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    expect(
      await screen.findByText(messages.console.coordinator.error.rate_limited),
    ).toBeInTheDocument();
  });

  it('explains a missing account in plain words', async () => {
    global.fetch = respond({ error: { code: 'NOT_FOUND' } }, 404) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    expect(
      await screen.findByText(messages.console.coordinator.error.not_found),
    ).toBeInTheDocument();
  });

  it('says when the organisation is not active', async () => {
    global.fetch = respond({ error: { code: 'TARGET_ORG_INACTIVE' } }, 409) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    expect(
      await screen.findByText(messages.console.coordinator.error.org_inactive),
    ).toBeInTheDocument();
  });

  it('confirms the approval on success', async () => {
    global.fetch = respond({ id: user.id, status: 'active', notified: true }, 200) as never;
    renderIt();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    expect(await screen.findByText(messages.console.coordinator.approved_note)).toBeInTheDocument();
  });

  it('shows no decision card for a coordinator who is not pending', () => {
    renderIt({ ...user, status: 'active' });
    expect(screen.queryByRole('button', { name: messages.console.coordinator.approve })).toBeNull();
    expect(screen.queryByText(messages.console.coordinator.decision_title)).toBeNull();
    expect(screen.queryByTestId('coordinator-status')).toBeNull();
  });

  const saveButton = () =>
    screen.getByRole('button', { name: messages.console.coordinator.save_domains });

  it('shows a coordinator with no saved domains as serving every configured domain', () => {
    renderIt(user, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    expect(screen.getByRole('checkbox', { name: /Seekers/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Providers/ })).toBeChecked();
    expect(
      screen.queryByRole('button', { name: messages.console.coordinator.save_domains }),
    ).toBeNull();
  });

  it('narrows the domains and saves the chosen ones', async () => {
    global.fetch = respond({ ...user, serves: ['seeker'] }, 200) as never;
    renderIt(user, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Providers/ }));
    expect(screen.getByText(messages.console.coordinator.unsaved)).toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByText(messages.console.coordinator.domains_saved)).toBeInTheDocument(),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/user/metadata/${user.id}`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ serves: ['seeker'] }) }),
    );
    expect(screen.getByRole('checkbox', { name: /Providers/ })).not.toBeChecked();
  });

  it('blocks saving an empty set and discards back to what was saved', () => {
    renderIt({ ...user, serves: ['seeker'] }, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Seekers/ }));
    expect(screen.getByText(messages.console.coordinator.domains_empty)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.discard }));
    expect(screen.getByRole('checkbox', { name: /Seekers/ })).toBeChecked();
    expect(
      screen.queryByRole('button', { name: messages.console.coordinator.save_domains }),
    ).toBeNull();
  });

  it('shows a generic error when saving domains fails', async () => {
    global.fetch = respond({ error: { code: 'BOOM' } }, 500) as never;
    renderIt(user, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Providers/ }));
    fireEvent.click(saveButton());
    expect(await screen.findByText(messages.console.coordinator.error.server)).toBeInTheDocument();
  });

  it('does not render the domains card when no domains are offered', () => {
    renderIt(user, []);
    expect(
      screen.queryByRole('button', { name: messages.console.coordinator.save_domains }),
    ).toBeNull();
  });

  it('shows status and served domains without any action when read-only (#873)', () => {
    renderIt(
      { ...user, serves: ['seeker'] },
      [
        { id: 'seeker', label: 'Seekers' },
        { id: 'provider', label: 'Providers' },
      ],
      true,
    );
    expect(screen.queryByTestId('coordinator-status')).toBeNull();
    expect(screen.getByText('Seekers')).toBeInTheDocument();
    expect(screen.queryByText('Providers')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('holds the decision until unsaved domain changes are saved or discarded', () => {
    renderIt(user, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Providers/ }));
    expect(screen.getByText(messages.console.coordinator.save_domains_first)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: messages.console.coordinator.approve }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: messages.console.coordinator.reject }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.discard }));
    expect(
      screen.getByRole('button', { name: messages.console.coordinator.approve }),
    ).toBeEnabled();
  });

  it('shows the domains read-only once the coordinator is decided', () => {
    renderIt({ ...user, status: 'active', serves: ['seeker'] }, [
      { id: 'seeker', label: 'Seekers' },
      { id: 'provider', label: 'Providers' },
    ]);
    expect(screen.getByText('Seekers')).toBeInTheDocument();
    expect(screen.queryByText('Providers')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('stops editing domains right after an approval', async () => {
    global.fetch = respond({ id: user.id, status: 'active', notified: true }, 200) as never;
    renderIt();
    expect(screen.getByRole('checkbox', { name: /Seekers/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: messages.console.coordinator.approve }));
    await waitFor(() => expect(screen.queryByRole('checkbox')).toBeNull());
  });

  it('lists every configured domain when a read-only coordinator has none saved', () => {
    renderIt(
      user,
      [
        { id: 'seeker', label: 'Seekers' },
        { id: 'provider', label: 'Providers' },
      ],
      true,
    );
    expect(screen.getByText('Seekers')).toBeInTheDocument();
    expect(screen.getByText('Providers')).toBeInTheDocument();
  });
});
