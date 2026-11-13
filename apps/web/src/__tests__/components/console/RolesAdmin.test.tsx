import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { Permission, Role } from '@aggregator-dpg/shared-primitives/user-org';
import { RolesAdmin } from '@/components/console/RolesAdmin';

const role = (key: string, isBuiltin: boolean, permissions: string[]): Role => ({
  key,
  name: key.replace('_', ' '),
  description: '',
  is_builtin: isBuiltin,
  account_type: 'coordinator',
  base_for: null,
  assignable_org_types: ['aggregator'],
  assigned_by: 'org.manage',
  max_days: null,
  permissions,
});
const PERMS: Permission[] = [
  {
    key: 'profiles.view',
    resource: 'profiles',
    action: 'view',
    description: 'See profiles',
    sensitive: false,
  },
  {
    key: 'profiles.verify',
    resource: 'profiles',
    action: 'verify',
    description: 'Verify',
    sensitive: false,
  },
];

function renderIt(roles: Role[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RolesAdmin initial={roles} permissions={PERMS} />
    </NextIntlClientProvider>,
  );
}

const respond = (body: unknown, status: number) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('<RolesAdmin />', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });

  it('lists built-in roles without actions and custom roles with them', () => {
    renderIt([
      role('coordinator', true, ['profiles.view']),
      role('verifier', false, ['profiles.verify']),
    ]);
    const builtin = screen.getByTestId('role-row-coordinator');
    expect(within(builtin).queryByRole('button')).toBeNull();
    const custom = screen.getByTestId('role-row-verifier');
    expect(
      within(custom).getByRole('button', { name: messages.console.roles_admin.delete }),
    ).toBeInTheDocument();
  });

  it('creates a role from chosen permissions', async () => {
    global.fetch = respond(role('verifier', false, ['profiles.verify']), 201) as never;
    renderIt([role('coordinator', true, ['profiles.view'])]);
    expect(screen.getByText(messages.console.roles_admin.none)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles_admin.create }));
    fireEvent.change(screen.getByLabelText(messages.console.roles_admin.key), {
      target: { value: 'verifier' },
    });
    fireEvent.change(screen.getByLabelText(messages.console.roles_admin.name), {
      target: { value: 'Verifier' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /profiles\.verify/ }));
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles_admin.save }));
    await waitFor(() => expect(screen.getByTestId('role-row-verifier')).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/console/roles/create',
      expect.objectContaining({ method: 'POST' }),
    );
    const sent = JSON.parse((vi.mocked(global.fetch).mock.calls[0]![1] as { body: string }).body);
    expect(sent).toMatchObject({
      key: 'verifier',
      name: 'Verifier',
      account_type: 'coordinator',
      assignable_org_types: ['aggregator'],
      assigned_by: 'org.manage',
      max_days: null,
      permissions: ['profiles.verify'],
    });
  });

  it('explains a refused role', async () => {
    global.fetch = respond(
      { error: { code: 'ROLE_INVALID', fields: { issues: ['x'] } } },
      400,
    ) as never;
    renderIt([]);
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles_admin.create }));
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles_admin.save }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(messages.console.errors.role_invalid),
    );
  });

  it('deletes a custom role, and explains one still in use', async () => {
    global.fetch = respond({ error: { code: 'ROLE_IN_USE' } }, 409) as never;
    renderIt([role('verifier', false, ['profiles.verify'])]);
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles_admin.delete }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(messages.console.errors.role_in_use),
    );
    global.fetch = respond({ deleted: true }, 200) as never;
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles_admin.delete }));
    await waitFor(() => expect(screen.queryByTestId('role-row-verifier')).toBeNull());
  });

  it('edits a custom role with its key and account type fixed', async () => {
    global.fetch = respond(
      role('verifier', false, ['profiles.verify', 'profiles.view']),
      200,
    ) as never;
    renderIt([role('verifier', false, ['profiles.verify'])]);
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles_admin.edit }));
    expect(screen.getByLabelText(messages.console.roles_admin.key)).toBeDisabled();
    expect(screen.getByLabelText(messages.console.roles_admin.account_type)).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /profiles\.view/ }));
    fireEvent.click(screen.getByRole('button', { name: messages.console.roles_admin.save }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(messages.console.roles_admin.saved),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/console/roles/update/verifier',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});
