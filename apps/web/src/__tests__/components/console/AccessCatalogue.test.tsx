import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import type {
  CataloguePermission,
  CatalogueRole,
} from '@aggregator-dpg/shared-primitives/user-org';
import { AccessCatalogue, type AccessTab } from '@/components/console/AccessCatalogue';

const ROLES: CatalogueRole[] = [
  {
    key: 'network_admin',
    name: 'Network Admin',
    description: "The root organisation's owner; administers the network.",
    is_builtin: true,
    held_by: 'org_owners',
    held_in: ['network_facilitator'],
    granted: { via: 'membership', membership: 'root_owner' },
    max_days: null,
    permissions: ['network.administer', 'org.manage'],
  },
  {
    key: 'pii_access',
    name: 'PII Access',
    description: 'Sees and exports decrypted profile details.',
    is_builtin: true,
    held_by: 'coordinators',
    held_in: ['aggregator'],
    granted: { via: 'assignment', assigned_by: 'org.manage' },
    max_days: 90,
    permissions: ['profiles.view_pii'],
  },
  {
    key: 'verifier',
    name: 'Verifier',
    description: '',
    is_builtin: false,
    held_by: 'coordinators',
    held_in: ['aggregator'],
    granted: { via: 'assignment', assigned_by: 'org.manage' },
    max_days: 1,
    permissions: [],
  },
];

const PERMISSIONS: CataloguePermission[] = [
  {
    key: 'agreement.manage',
    description: 'Create and link agreements (terms, privacy, consent)',
    resource: 'agreements',
    action: 'manage',
    personal_data: false,
    retired: true,
    granted_by_roles: [],
  },
  {
    key: 'profiles.view_pii',
    description: 'See and export decrypted details',
    resource: 'profiles',
    action: 'view_pii',
    personal_data: true,
    retired: false,
    granted_by_roles: ['pii_access'],
  },
];

const withIntl = (ui: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

const show = (tab: AccessTab) =>
  withIntl(<AccessCatalogue tab={tab} roles={ROLES} permissions={PERMISSIONS} />);

const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });
const search = (text: string) =>
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: text } });

describe('<AccessCatalogue /> summary and tabs', () => {
  it('counts roles, live permissions, personal-data permissions and custom roles', () => {
    show('roles');
    expect(screen.getByRole('button', { name: /^Permissions\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Roles\s*3/ })).toBeInTheDocument();
    expect(screen.getByText(messages.console.access.stat_custom).closest('div')).toHaveTextContent(
      '1',
    );
  });

  it('opens the tab it was given and switches between the three', () => {
    show('permissions');
    expect(tab('Permissions')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tab('Matrix'));
    expect(screen.getByText(messages.console.access.subtitle_matrix)).toBeInTheDocument();
    fireEvent.click(tab('Roles'));
    expect(screen.getByText(messages.console.access.subtitle_roles)).toBeInTheDocument();
  });

  it('has no controls to create, edit, delete or assign', () => {
    show('roles');
    expect(screen.queryByRole('button', { name: /^(create|edit|delete|assign)$/i })).toBeNull();
  });
});

describe('<AccessCatalogue /> roles', () => {
  it('groups roles by where they are held and shows the first one in detail', () => {
    show('roles');
    expect(screen.getByText(messages.console.access.scope_network)).toBeInTheDocument();
    expect(screen.getByText(messages.console.access.scope_aggregator)).toBeInTheDocument();
    const detail = screen.getByRole('complementary', { name: 'Network Admin' });
    expect(detail).toHaveTextContent('network.administer');
    expect(detail).toHaveTextContent(messages.console.access.footer_membership);
  });

  it('shows another role, its validity and a custom role with no permissions', () => {
    show('roles');
    fireEvent.click(screen.getByRole('button', { name: /PII Access/ }));
    const pii = screen.getByRole('complementary', { name: 'PII Access' });
    expect(pii).toHaveTextContent('Valid for up to 90 days');
    expect(pii).toHaveTextContent(messages.console.access.footer_assigned);
    fireEvent.click(screen.getByRole('button', { name: /Verifier/ }));
    const verifier = screen.getByRole('complementary', { name: 'Verifier' });
    expect(verifier).toHaveTextContent('No permissions');
    expect(screen.getByRole('button', { name: /Verifier/ })).toHaveTextContent(
      messages.console.access.custom,
    );
  });

  it('narrows roles by search and says so when nothing matches', () => {
    show('roles');
    search('view_pii');
    expect(screen.queryByRole('button', { name: /Network Admin/ })).toBeNull();
    expect(screen.getByRole('button', { name: /PII Access/ })).toBeInTheDocument();
    search('nothing-like-this');
    expect(screen.getByText('Nothing matches “nothing-like-this”.')).toBeInTheDocument();
  });

  it('keeps only roles that expose personal data when that filter is on', () => {
    show('roles');
    fireEvent.click(screen.getByRole('button', { name: messages.console.access.personal_only }));
    expect(screen.queryByRole('button', { name: /Network Admin/ })).toBeNull();
    expect(screen.getByRole('button', { name: /PII Access/ })).toBeInTheDocument();
  });

  it('opens a permission from a role on the permissions tab', () => {
    show('roles');
    fireEvent.click(screen.getByRole('button', { name: /PII Access/ }));
    fireEvent.click(screen.getByRole('button', { name: /profiles\.view_pii/ }));
    expect(tab('Permissions')).toHaveAttribute('aria-selected', 'true');
    expect(document.getElementById('permission-profiles.view_pii')).toBeInTheDocument();
  });

  it('says so when there are no roles', () => {
    withIntl(<AccessCatalogue tab="roles" roles={[]} permissions={PERMISSIONS} />);
    expect(screen.getByText(messages.console.access.roles_empty)).toBeInTheDocument();
  });
});

describe('<AccessCatalogue /> permissions', () => {
  it('lists each permission by area with its personal-data flag and granting roles', () => {
    show('permissions');
    const pii = document.getElementById('permission-profiles.view_pii')!;
    expect(pii).toHaveTextContent('See and export decrypted details');
    expect(pii).toHaveTextContent(messages.console.access.yes);
    expect(within(pii).getByRole('button', { name: 'PII Access' })).toBeInTheDocument();
    expect(screen.getByText('profiles.*')).toBeInTheDocument();
  });

  it('tags a retired permission and says when no role grants it', () => {
    show('permissions');
    const row = document.getElementById('permission-agreement.manage')!;
    expect(row).toHaveTextContent(messages.console.access.retired);
    expect(row).toHaveTextContent(messages.console.access.granted_by_none);
  });

  it('opens a granting role on the roles tab', () => {
    show('permissions');
    fireEvent.click(screen.getByRole('button', { name: 'PII Access' }));
    expect(tab('Roles')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('complementary', { name: 'PII Access' })).toBeInTheDocument();
  });

  it('narrows permissions by key, description or role name', () => {
    show('permissions');
    search('pii access');
    expect(document.getElementById('permission-agreement.manage')).toBeNull();
    expect(document.getElementById('permission-profiles.view_pii')).toBeInTheDocument();
  });

  it('says so when there are no permissions', () => {
    withIntl(<AccessCatalogue tab="permissions" roles={ROLES} permissions={[]} />);
    expect(screen.getByText(messages.console.access.permissions_empty)).toBeInTheDocument();
  });
});

describe('<AccessCatalogue /> matrix', () => {
  it('marks which role grants each live permission and totals each role', () => {
    show('matrix');
    const row = screen.getByText('profiles.view_pii').closest('tr')!;
    expect(within(row).getAllByLabelText(messages.console.access.yes)).toHaveLength(1);
    expect(screen.queryByText('agreement.manage')).toBeNull();
    expect(screen.getByText(messages.console.access.total).closest('tr')).toHaveTextContent(
      /2\s*1\s*0/,
    );
  });
  it('keeps every role when the search names a permission, and narrows to a named role', () => {
    show('matrix');
    search('decrypted');
    const row = screen.getByText('profiles.view_pii').closest('tr')!;
    expect(within(row).getAllByLabelText(messages.console.access.yes)).toHaveLength(1);
    expect(screen.getAllByRole('columnheader')).toHaveLength(ROLES.length + 1);
    search('pii access');
    expect(screen.getAllByRole('columnheader')).toHaveLength(2);
  });
});
