import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type {
  Role,
  RoleAssignment,
  UserRolesResponse,
} from '@aggregator-dpg/shared-primitives/user-org';
import { RolesPanel } from '@/components/console/RolesPanel';

const userId = '00000000-0000-4000-8000-0000000000c1';
const orgId = '00000000-0000-4000-8000-00000000000a';

const role = (key: string, name: string, maxDays: number | null = null): Role => ({
  key,
  name,
  description: '',
  is_builtin: true,
  account_type: 'coordinator',
  base_for: key === 'coordinator' ? 'org_member' : null,
  assignable_org_types: ['aggregator'],
  assigned_by: key === 'coordinator' ? null : 'org.manage',
  max_days: maxDays,
  permissions: key === 'pii_access' ? ['profiles.view_pii'] : ['profiles.export'],
});
const ROLES = [
  role('coordinator', 'Coordinator'),
  role('pii_access', 'PII Access', 90),
  role('data_export', 'Data Export'),
];

const live = (key: string, expires: string | null): RoleAssignment => ({
  id: `a-${key}`,
  role_key: key,
  org_id: orgId,
  granted_by: null,
  granted_at: '2026-10-01T00:00:00Z',
  expires_at: expires,
  revoked_at: null,
  live: true,
});

const initial = (additional: RoleAssignment[] = []): UserRolesResponse => ({
  base: [{ role_key: 'coordinator', org_id: orgId }],
  additional,
  assignable: [
    { role_key: 'data_export', org_id: orgId },
    { role_key: 'pii_access', org_id: orgId },
  ],
});

function renderIt(init: UserRolesResponse) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RolesPanel userId={userId} orgId={orgId} initial={init} roles={ROLES} />
    </NextIntlClientProvider>,
  );
}

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('<RolesPanel />', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });

  it('shows the base role and the assignable roles', () => {
    renderIt(initial());
    const base = screen.getByTestId('role-base-coordinator');
    expect(base).toHaveTextContent('Coordinator');
    expect(base).toHaveTextContent(messages.console.roles.base_tag);
    expect(base).toHaveTextContent(messages.console.roles.locked);
    expect(screen.getByTestId('role-pii_access')).toHaveTextContent(messages.console.roles.none);
    expect(screen.getByText(messages.console.roles.personal_data)).toBeInTheDocument();
    const duration = screen.getByRole('combobox', { name: 'Duration for PII Access' });
    expect(duration).toHaveValue('90');
    expect(Array.from((duration as HTMLSelectElement).options).map((o) => o.value)).toEqual([
      '30',
      '60',
      '90',
    ]);
    expect(screen.getAllByRole('button', { name: messages.console.roles.assign })).toHaveLength(2);
  });

  it('renders nothing when the user has no role here', () => {
    const { container } = renderIt({ base: [], additional: [], assignable: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('asks before giving personal-data access, then assigns for the chosen days', async () => {
    global.fetch = respond(live('pii_access', '2026-12-30T00:00:00Z'), 200) as never;
    renderIt(initial());
    fireEvent.change(screen.getByRole('combobox', { name: 'Duration for PII Access' }), {
      target: { value: '30' },
    });
    const [, piiAssign] = screen.getAllByRole('button', { name: messages.console.roles.assign });
    fireEvent.click(piiAssign!);
    const dialog = screen.getByRole('dialog', { name: 'Give PII Access?' });
    expect(dialog).toHaveTextContent('This person will see personal data for 30 days.');
    expect(global.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles.confirm_pii_yes }));
    await waitFor(() =>
      expect(screen.getByTestId('role-pii_access')).toHaveTextContent('Until Dec 30, 2026'),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/user/role/assign/${userId}`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ role_key: 'pii_access', org_id: orgId, days: 30 }),
      }),
    );
  });

  it('says a personal-data role without a day limit lasts until removed', () => {
    const roles = [
      ...ROLES,
      { ...role('pii_custom', 'PII Custom'), permissions: ['profiles.view_pii'] },
    ];
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <RolesPanel
          userId={userId}
          orgId={orgId}
          initial={{ ...initial(), assignable: [{ role_key: 'pii_custom', org_id: orgId }] }}
          roles={roles}
          personName="Asha"
        />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles.assign }));
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Asha will see personal data until this role is removed.',
    );
  });

  it('keeps focus inside the confirmation and returns it on close', () => {
    renderIt(initial());
    const [, piiAssign] = screen.getAllByRole('button', { name: messages.console.roles.assign });
    piiAssign!.focus();
    fireEvent.click(piiAssign!);
    const confirm = screen.getByRole('button', { name: messages.console.roles.confirm_pii_yes });
    const cancel = screen.getByRole('button', { name: messages.console.roles.cancel });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(piiAssign).toHaveFocus();
  });

  it('cancels the personal-data confirmation without assigning', () => {
    global.fetch = vi.fn() as never;
    renderIt(initial());
    const [, piiAssign] = screen.getAllByRole('button', { name: messages.console.roles.assign });
    fireEvent.click(piiAssign!);
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles.cancel }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('revokes a live role', async () => {
    global.fetch = respond({ revoked: true }, 200) as never;
    renderIt(initial([live('data_export', null)]));
    expect(screen.getByTestId('role-data_export')).toHaveTextContent(
      messages.console.roles.no_expiry,
    );
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles.revoke }));
    expect(screen.getByRole('dialog', { name: 'Remove Data Export?' })).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: messages.console.roles.revoke,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('role-data_export')).toHaveTextContent(messages.console.roles.none),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      `/api/console/user/role/revoke/${userId}`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('explains a refused assignment', async () => {
    global.fetch = respond(
      { error: { code: 'ROLE_ASSIGNMENT_NOT_ALLOWED', fields: { reason: 'account_type' } } },
      409,
    ) as never;
    renderIt(initial());
    const [exportAssign] = screen.getAllByRole('button', { name: messages.console.roles.assign });
    fireEvent.click(exportAssign!);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        messages.console.errors.role_not_allowed,
      ),
    );
  });

  it('shows a live role the caller cannot revoke without a revoke button', () => {
    renderIt({ ...initial([live('pii_access', null)]), assignable: [] });
    expect(screen.getByTestId('role-pii_access')).toHaveTextContent(
      messages.console.roles.no_expiry,
    );
    expect(screen.queryByRole('button', { name: messages.console.roles.revoke })).toBeNull();
  });
});
