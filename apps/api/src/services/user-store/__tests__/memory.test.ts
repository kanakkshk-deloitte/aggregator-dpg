/**
 * Unit tests for the in-memory aggregator store's contact rules
 * (`@aggregator-dpg/api`): one person per email and per phone, a canonical
 * phone (the Postgres store's CHECK), and NOT_FOUND on unknown ids — the same
 * outcomes the Postgres adapter reports, so route tests built on the fake see
 * real behaviour.
 */
import { describe, expect, it } from 'vitest';
import { contactId } from '@aggregator-dpg/shared-primitives/contact';
import { InMemoryUserStore } from '../memory.js';
import { UserStoreFake, buildCoordinator, buildCreateCoordinatorInput } from '../testing.js';

const contactOf = (email: string, phone: string) => ({ name: 'Asha', email, phone });

/** A store holding one coordinator (`a@x.org`, `+919000000001`); returns its id. */
async function seeded(): Promise<{ store: InMemoryUserStore; id: string }> {
  const store = new InMemoryUserStore();
  const r = await store.create(
    buildCreateCoordinatorInput({ orgSlug: 'one', contact: contactOf('a@x.org', '+919000000001') }),
  );
  if (!r.ok) throw new Error('seed failed');
  return { store, id: r.value.id };
}

describe('InMemoryUserStore.create', () => {
  it('stores the contact id, lowercased email and phone', async () => {
    const { store, id } = await seeded();
    const found = await store.findById(id);
    expect(found.ok && found.value?.contactId).toBe(contactId('a@x.org', '+919000000001'));
    expect(found.ok && found.value?.contactEmail).toBe('a@x.org');
  });

  it.each([
    ['DUPLICATE_SLUG', { orgSlug: 'one', contact: contactOf('b@x.org', '+919000000002') }],
    ['DUPLICATE_PHONE', { orgSlug: 'two', contact: contactOf('b@x.org', '+919000000001') }],
    ['DUPLICATE_EMAIL', { orgSlug: 'two', contact: contactOf('A@X.org', '+919000000002') }],
    ['CHECK_VIOLATION', { orgSlug: 'two', contact: contactOf('b@x.org', '9000000002') }],
  ] as const)('returns %s', async (code, overrides) => {
    const { store } = await seeded();
    const r = await store.create(buildCreateCoordinatorInput(overrides));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });
});

describe('InMemoryUserStore lookups', () => {
  it('returns null for an unknown slug, phone or email', async () => {
    const { store } = await seeded();
    expect(await store.findBySlug('nope')).toEqual({ ok: true, value: null });
    expect(await store.findByContactPhone('+919999999999')).toEqual({ ok: true, value: null });
    expect(await store.findByContactEmail('nobody@x.org')).toEqual({ ok: true, value: null });
  });

  it('finds by email case-insensitively', async () => {
    const { store, id } = await seeded();
    const r = await store.findByContactEmail('A@X.ORG');
    expect(r.ok && r.value?.id).toBe(id);
  });
});

describe('InMemoryUserStore.update', () => {
  it('re-derives the contact id when the phone changes', async () => {
    const { store, id } = await seeded();
    const r = await store.update(id, {
      contact: contactOf('a@x.org', '+919000000003'),
      updatedBy: 't',
    });
    expect(r.ok && r.value.contactId).toBe(contactId('a@x.org', '+919000000003'));
    expect(await store.findByContactPhone('+919000000001')).toEqual({ ok: true, value: null });
  });

  it.each([
    ['DUPLICATE_PHONE', contactOf('a@x.org', '+919000000002')],
    ['DUPLICATE_EMAIL', contactOf('b@x.org', '+919000000001')],
    ['CHECK_VIOLATION', contactOf('a@x.org', '12345')],
  ] as const)('returns %s', async (code, next) => {
    const { store, id } = await seeded();
    await store.create(
      buildCreateCoordinatorInput({
        orgSlug: 'two',
        contact: contactOf('b@x.org', '+919000000002'),
      }),
    );
    const r = await store.update(id, { contact: next, updatedBy: 't' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it('returns NOT_FOUND for an unknown id on every write', async () => {
    const store = new InMemoryUserStore();
    const update = await store.update('missing', { name: 'x', updatedBy: 't' });
    const stamp = await store.updateSignalstackOrgId('missing', 'org_1', 't');
    const del = await store.deleteById('missing');
    for (const r of [update, stamp, del]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('NOT_FOUND');
    }
  });
});

describe('InMemoryUserStore — consent hook and serves (0029)', () => {
  it('runs recordConsent with the new id and stores the row', async () => {
    const store = new InMemoryUserStore();
    const seen: string[] = [];
    const r = await store.create(
      buildCreateCoordinatorInput({
        recordConsent: async (_tx, id) => {
          seen.push(id);
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seen).toEqual([r.value.id]);
  });

  it('stores nothing and answers CONSENT_WRITE_FAILED when the hook throws', async () => {
    const store = new InMemoryUserStore();
    const input = buildCreateCoordinatorInput({
      recordConsent: async () => {
        throw new Error('ledger down');
      },
    });
    const r = await store.create(input);
    expect(r).toEqual({
      ok: false,
      error: { code: 'CONSENT_WRITE_FAILED', message: 'consent could not be recorded' },
    });
    const found = await store.findBySlug(input.orgSlug);
    expect(found.ok && found.value).toBeNull();
  });

  it.each([
    ['seeker', ['seeker'], 'seeker'],
    [null, [], null],
  ] as const)('type %s → serves %j, type %s', async (type, serves, readType) => {
    const store = new InMemoryUserStore();
    const r = await store.create(buildCreateCoordinatorInput({ type }));
    expect(r.ok && r.value.serves).toEqual(serves);
    expect(r.ok && r.value.type).toBe(readType);
    expect(r.ok && r.value.actorType).toBe('aggregator');
  });

  it('a type patch rewrites serves', async () => {
    const store = new InMemoryUserStore();
    const r = await store.create(buildCreateCoordinatorInput());
    if (!r.ok) throw new Error('seed');
    const u = await store.update(r.value.id, { type: 'provider', updatedBy: 't' });
    expect(u.ok && u.value.serves).toEqual(['provider']);
    expect(u.ok && u.value.type).toBe('provider');
  });
});

describe('InMemoryUserStore CAS, list, search and counts', () => {
  it('approveFromPending / rejectFromPending return null for an already-decided row', async () => {
    const store = new UserStoreFake();
    store.seed([buildCoordinator({ id: 'a1', status: 'active' })]);
    expect(await store.approveFromPending('a1', 't')).toEqual({ ok: true, value: null });
    expect(await store.rejectFromPending('a1', 't')).toEqual({ ok: true, value: null });
  });

  it('rejectFromPending stamps inactive + rejected_at for a pending row', async () => {
    const store = new UserStoreFake();
    store.seed([buildCoordinator({ id: 'p1', status: 'pending' })]);
    const r = await store.rejectFromPending('p1', 't');
    expect(r.ok && r.value?.status).toBe('inactive');
    expect(r.ok && r.value?.rejectedAt).toBeInstanceOf(Date);
  });

  it('list filters by status and updatedBefore, honouring offset and limit', async () => {
    const store = new UserStoreFake();
    store.seed([
      buildCoordinator({ id: 'r1', orgSlug: 's1', status: 'active', createdAt: new Date(3000) }),
      buildCoordinator({ id: 'r2', orgSlug: 's2', status: 'active', createdAt: new Date(2000) }),
      buildCoordinator({ id: 'r3', orgSlug: 's3', status: 'pending', createdAt: new Date(1000) }),
    ]);
    const active = await store.list({ status: 'active', limit: 1, offset: 1 });
    expect(active.ok && active.value.total).toBe(2);
    expect(active.ok && active.value.rows).toHaveLength(1);
    const before = await store.list({ updatedBefore: new Date(1500) });
    expect(before.ok && before.value.rows.map((r) => r.id)).toEqual(['r3']);
  });

  it('search scopes by orgIds, status and serves, and pages with a cursor', async () => {
    const store = new UserStoreFake();
    store.seed([
      buildCoordinator({
        id: 'c1',
        orgSlug: 'o1',
        parentOrgId: 'org-a',
        serves: ['seeker'],
        status: 'active',
        createdAt: new Date(3000),
      }),
      buildCoordinator({
        id: 'c2',
        orgSlug: 'o2',
        parentOrgId: 'org-a',
        serves: [],
        status: 'active',
        createdAt: new Date(2000),
      }),
      buildCoordinator({
        id: 'c3',
        orgSlug: 'o3',
        parentOrgId: 'org-b',
        serves: ['provider'],
        status: 'pending',
        createdAt: new Date(1000),
      }),
    ]);
    const scoped = await store.search({ orgIds: ['org-a'], serves: 'seeker', limit: 20 });
    // org-a rows serving seeker: c1 (explicit) and c2 (serves-all).
    expect(scoped.ok && scoped.value.rows.map((r) => r.id).sort()).toEqual(['c1', 'c2']);

    const page1 = await store.search({ orgIds: null, limit: 1 });
    expect(page1.ok && page1.value.rows.map((r) => r.id)).toEqual(['c1']);
    expect(page1.ok && page1.value.nextCursor).not.toBeNull();
    if (page1.ok && page1.value.nextCursor) {
      const page2 = await store.search({ orgIds: null, limit: 1, cursor: page1.value.nextCursor });
      expect(page2.ok && page2.value.rows.map((r) => r.id)).toEqual(['c2']);
    }

    const pending = await store.search({ orgIds: null, status: 'pending', limit: 20 });
    expect(pending.ok && pending.value.rows.map((r) => r.id)).toEqual(['c3']);
  });

  it('countByOrg tallies totals and pending per requested org', async () => {
    const store = new UserStoreFake();
    store.seed([
      buildCoordinator({ id: 'c1', orgSlug: 'o1', parentOrgId: 'org-a', status: 'active' }),
      buildCoordinator({ id: 'c2', orgSlug: 'o2', parentOrgId: 'org-a', status: 'pending' }),
      buildCoordinator({ id: 'c3', orgSlug: 'o3', parentOrgId: 'org-z', status: 'pending' }),
    ]);
    const counts = await store.countByOrg(['org-a', 'org-b']);
    expect(counts.ok && counts.value['org-a']).toEqual({ total: 2, pending: 1 });
    expect(counts.ok && counts.value['org-b']).toEqual({ total: 0, pending: 0 });
  });

  it('findByParentOrgId returns the org members', async () => {
    const store = new UserStoreFake();
    store.seed([
      buildCoordinator({ id: 'c1', orgSlug: 'o1', parentOrgId: 'org-a' }),
      buildCoordinator({ id: 'c2', orgSlug: 'o2', parentOrgId: 'org-b' }),
    ]);
    const r = await store.findByParentOrgId('org-a');
    expect(r.ok && r.value.map((x) => x.id)).toEqual(['c1']);
  });

  it('updateStatus and updateSignalstackOrgId write through', async () => {
    const store = new UserStoreFake();
    store.seed([buildCoordinator({ id: 's1', status: 'pending' })]);
    const st = await store.updateStatus('s1', 'active', 't');
    expect(st.ok && st.value.status).toBe('active');
    const sig = await store.updateSignalstackOrgId('s1', 'org_x', 't');
    expect(sig.ok && sig.value.signalstackOrgId).toBe('org_x');
  });

  it('re-indexes email and phone when an update changes both', async () => {
    const store = new InMemoryUserStore();
    const created = await store.create(
      buildCreateCoordinatorInput({
        orgSlug: 'idx',
        contact: { name: 'A', email: 'before@x.org', phone: '+919000000011' },
      }),
    );
    if (!created.ok) throw new Error('seed');
    const u = await store.update(created.value.id, {
      contact: { name: 'A', email: 'after@x.org', phone: '+919000000012' },
      updatedBy: 't',
    });
    expect(u.ok).toBe(true);
    expect(await store.findByContactEmail('before@x.org')).toEqual({ ok: true, value: null });
    expect(await store.findByContactPhone('+919000000011')).toEqual({ ok: true, value: null });
    const after = await store.findByContactEmail('after@x.org');
    expect(after.ok && after.value?.contactPhone).toBe('+919000000012');
  });

  it('a serves patch rewrites serves and the derived type', async () => {
    const store = new InMemoryUserStore();
    const r = await store.create(buildCreateCoordinatorInput());
    if (!r.ok) throw new Error('seed');
    const u = await store.update(r.value.id, {
      serves: ['seeker', 'seeker', 'provider'],
      updatedBy: 't',
    });
    expect(u.ok && u.value.serves).toEqual(['seeker', 'provider']);
    expect(u.ok && u.value.type).toBe('seeker');
  });

  it('deleteIfPending deletes a stale pending row, aborts on a false hook, skips a decided row', async () => {
    const store = new InMemoryUserStore();
    const mk = async (slug: string, phone: string) =>
      store.create(
        buildCreateCoordinatorInput({
          orgSlug: slug,
          contact: { name: 'A', email: `${slug}@x.org`, phone },
        }),
      );
    const a = await mk('del', '+919000000021');
    const b = await mk('keep', '+919000000022');
    const c = await mk('abort', '+919000000023');
    if (!a.ok || !b.ok || !c.ok) throw new Error('seed');
    const future = new Date(Date.now() + 3600_000);
    const del = await store.deleteIfPending(a.value.id, future, async () => true);
    expect(del.ok && del.value).toBe('deleted');
    expect(await store.findById(a.value.id)).toEqual({ ok: true, value: null });

    await store.updateStatus(b.value.id, 'active', 't');
    const kept = await store.deleteIfPending(b.value.id, future, async () => true);
    expect(kept.ok && kept.value).toBe('not_pending');

    const aborted = await store.deleteIfPending(c.value.id, future, async () => false);
    expect(aborted.ok && aborted.value).toBe('aborted');
    expect((await store.findById(c.value.id)).ok).toBe(true);
  });

  it('renders an alternate phone and re-renders seeded org details on read', async () => {
    const store = new UserStoreFake();
    store.seedOrgDetails('org-d', { url: 'https://org-d.example', legalName: 'Org D Ltd' });
    const r = await store.create(
      buildCreateCoordinatorInput({
        orgSlug: 'altp',
        orgId: 'org-d',
        contact: {
          name: 'A',
          email: 'altp@x.org',
          phone: '+919000000031',
          alternatePhone: '+919000000032',
        },
      }),
    );
    expect(r.ok && r.value.contact.alternatePhone).toBe('+919000000032');
    expect(r.ok && r.value.url).toBe('https://org-d.example');
    expect(r.ok && r.value.contact.company).toBe('Org D Ltd');
  });
});
