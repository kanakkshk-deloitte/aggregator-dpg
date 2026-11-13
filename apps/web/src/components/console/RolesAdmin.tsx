'use client';

/**
 * Roles page body for the network admin: built-in roles (read-only) and
 * custom roles, which can be created from existing permissions, edited, and
 * deleted. The API checks every role rule.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Permission, Role } from '@aggregator-dpg/shared-primitives/user-org';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { errorKey, sendConsole } from '../../lib/console-client';

const ORG_TYPES = ['aggregator', 'network_facilitator'] as const;
const ASSIGNERS = ['org.manage', 'network.administer'] as const;

interface Draft {
  key: string;
  name: string;
  description: string;
  account_type: 'admin' | 'coordinator';
  assignable_org_types: string[];
  assigned_by: string;
  max_days: string;
  permissions: string[];
}

const empty: Draft = {
  key: '',
  name: '',
  description: '',
  account_type: 'coordinator',
  assignable_org_types: ['aggregator'],
  assigned_by: 'org.manage',
  max_days: '',
  permissions: [],
};

const draftOf = (r: Role): Draft => ({
  key: r.key,
  name: r.name,
  description: r.description,
  account_type: r.account_type,
  assignable_org_types: r.assignable_org_types,
  assigned_by: r.assigned_by ?? 'org.manage',
  max_days: r.max_days ? String(r.max_days) : '',
  permissions: r.permissions,
});

export function RolesAdmin({
  initial,
  permissions,
}: {
  initial: Role[];
  permissions: Permission[];
}) {
  const t = useTranslations('console');
  const [roles, setRoles] = useState<Role[]>(initial);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const builtin = roles.filter((r) => r.is_builtin);
  const custom = roles.filter((r) => !r.is_builtin);
  const toggle = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  function open(key: string | null) {
    setEditing(key ?? '');
    const r = key ? roles.find((x) => x.key === key) : undefined;
    setDraft(r ? draftOf(r) : empty);
    setNote(null);
  }

  async function save() {
    setBusy(true);
    const common = {
      name: draft.name,
      description: draft.description,
      assignable_org_types: draft.assignable_org_types,
      assigned_by: draft.assigned_by,
      max_days: draft.max_days ? Number(draft.max_days) : null,
      permissions: draft.permissions,
    };
    const r = editing
      ? await sendConsole<Role>(`/api/console/roles/update/${editing}`, 'PATCH', common)
      : await sendConsole<Role>('/api/console/roles/create', 'POST', {
          ...common,
          key: draft.key,
          account_type: draft.account_type,
        });
    setBusy(false);
    if (r.ok) {
      setRoles((rs) => [...rs.filter((x) => x.key !== r.data.key), r.data]);
      setEditing(null);
      setNote(t('roles_admin.saved'));
    } else {
      setNote(t(errorKey(r)));
    }
  }

  async function remove(key: string) {
    setBusy(true);
    const r = await sendConsole<{ deleted: boolean }>(
      `/api/console/roles/delete/${key}`,
      'POST',
      {},
    );
    setBusy(false);
    if (r.ok) {
      setRoles((rs) => rs.filter((x) => x.key !== key));
      setNote(t('roles_admin.deleted'));
    } else {
      setNote(t(errorKey(r)));
    }
  }

  const row = (r: Role, actions: boolean) => (
    <li key={r.key} data-testid={`role-row-${r.key}`} className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold">{r.name}</span>
        <span className="text-ink-500">{r.key}</span>
        {actions ? (
          <>
            <Button kind="ghost" disabled={busy} onClick={() => open(r.key)}>
              {t('roles_admin.edit')}
            </Button>
            <Button kind="danger" disabled={busy} onClick={() => void remove(r.key)}>
              {t('roles_admin.delete')}
            </Button>
          </>
        ) : null}
      </div>
      <span className="text-[12px] text-ink-600">{r.permissions.join(', ')}</span>
    </li>
  );

  return (
    <div className="flex flex-col gap-4 text-[13.5px]">
      <Card className="p-4 flex flex-col gap-2">
        <span className="bd-label">{t('roles_admin.builtin')}</span>
        <span className="text-[12px] text-ink-500">{t('roles_admin.builtin_hint')}</span>
        <ul>{builtin.map((r) => row(r, false))}</ul>
      </Card>

      <Card className="p-4 flex flex-col gap-2">
        <span className="bd-label">{t('roles_admin.custom')}</span>
        {custom.length === 0 ? (
          <span>{t('roles_admin.none')}</span>
        ) : (
          <ul>{custom.map((r) => row(r, true))}</ul>
        )}
        {editing === null ? (
          <div>
            <Button disabled={busy} onClick={() => open(null)}>
              {t('roles_admin.create')}
            </Button>
          </div>
        ) : (
          <form
            aria-label={t('roles_admin.create')}
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="flex flex-col gap-1">
              <span className="bd-label">{t('roles_admin.key')}</span>
              <input
                className="bd-input"
                value={draft.key}
                disabled={editing !== ''}
                onChange={(e) => setDraft({ ...draft, key: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="bd-label">{t('roles_admin.name')}</span>
              <input
                className="bd-input"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="bd-label">{t('roles_admin.description')}</span>
              <input
                className="bd-input"
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="bd-label">{t('roles_admin.account_type')}</span>
              <select
                className="bd-input"
                value={draft.account_type}
                disabled={editing !== ''}
                onChange={(e) =>
                  setDraft({ ...draft, account_type: e.target.value as Draft['account_type'] })
                }
              >
                <option value="coordinator">{t('roles_admin.account_coordinator')}</option>
                <option value="admin">{t('roles_admin.account_admin')}</option>
              </select>
            </label>
            <fieldset className="flex flex-col gap-1">
              <legend className="bd-label">{t('roles_admin.org_types')}</legend>
              {ORG_TYPES.map((o) => (
                <label key={o} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.assignable_org_types.includes(o)}
                    onChange={() =>
                      setDraft({
                        ...draft,
                        assignable_org_types: toggle(draft.assignable_org_types, o),
                      })
                    }
                  />
                  {t(`roles_admin.org_${o}`)}
                </label>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1">
              <span className="bd-label">{t('roles_admin.assigned_by')}</span>
              <select
                className="bd-input"
                value={draft.assigned_by}
                onChange={(e) => setDraft({ ...draft, assigned_by: e.target.value })}
              >
                {ASSIGNERS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="bd-label">{t('roles_admin.max_days')}</span>
              <input
                className="bd-input"
                type="number"
                min={1}
                value={draft.max_days}
                onChange={(e) => setDraft({ ...draft, max_days: e.target.value })}
              />
            </label>
            <fieldset className="flex flex-col gap-1">
              <legend className="bd-label">{t('roles_admin.permissions')}</legend>
              {permissions.map((p) => (
                <label key={p.key} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.permissions.includes(p.key)}
                    onChange={() =>
                      setDraft({ ...draft, permissions: toggle(draft.permissions, p.key) })
                    }
                  />
                  <span>{p.key}</span>
                  <span className="text-[12px] text-ink-500">{p.description}</span>
                  {p.enforced ? null : (
                    <span className="text-[12px] text-ink-500 italic">
                      {t('roles_admin.not_enforced')}
                    </span>
                  )}
                </label>
              ))}
            </fieldset>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {t('roles_admin.save')}
              </Button>
              <Button kind="ghost" disabled={busy} onClick={() => setEditing(null)}>
                {t('roles_admin.cancel')}
              </Button>
            </div>
          </form>
        )}
        {note ? (
          <p role="status" className="text-ink-600">
            {note}
          </p>
        ) : null}
      </Card>
    </div>
  );
}
