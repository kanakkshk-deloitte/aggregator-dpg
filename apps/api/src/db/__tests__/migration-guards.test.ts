/**
 * Unit tests for the pre-migration guards (`db/migration-guards.ts`,
 * `@aggregator-dpg/api`): the foreign-migration classification and the
 * instance-upgrade refusal rule. The database-reading wrapper is exercised by the
 * integration suite.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkForeign,
  runMigrationGuards,
  upgradeRefusal,
  UPGRADE_FIRST_WHEN,
  UPGRADE_LAST_WHEN,
  type JournalEntry,
} from '../migration-guards.js';

/** Migrations after the instance upgrade, each additive and safe to apply at boot. */
const BOOT_SAFE_AFTER_UPGRADE = [
  '0030_rbac',
  '0031_rbac_seed',
  '0032_org_known_as',
  '0033_org_description_profile',
  // Adds `org_known_as` and resets `known_as` to `aggregator` (a display label only); idempotent.
  '0034_org_known_as',
  // Adds orgs.onboard to the built-in Org Admin role; idempotent.
  '0035_org_admin_onboard',
];

const journal: JournalEntry[] = [
  { when: 1788400000000, tag: '0022_campaign_pii_audit' },
  { when: UPGRADE_FIRST_WHEN, tag: '0023_drop_aggregator_profile' },
  { when: 1790900000000, tag: '0026_contact_drop_legacy' },
  { when: UPGRADE_LAST_WHEN, tag: '0027_users' },
];

describe('checkForeign', () => {
  const hashes = new Map(journal.map((e) => [e.when, `h-${e.tag}`]));

  it('accepts rows that match a shipped migration', () => {
    const v = checkForeign(
      journal,
      [{ createdAt: 1788400000000, hash: 'h-0022_campaign_pii_audit' }],
      hashes,
    );
    expect(v).toEqual({ unknown: [], hashMismatches: [] });
  });

  it('reports a row whose created_at is in no journal entry (e.g. abandoned app_user)', () => {
    const v = checkForeign(journal, [{ createdAt: 1791000000000, hash: 'x' }], hashes);
    expect(v.unknown).toEqual([{ createdAt: 1791000000000, hash: 'x' }]);
  });

  it('only flags a hash mismatch on a known when (file edited after release)', () => {
    const v = checkForeign(journal, [{ createdAt: 1790900000000, hash: 'older' }], hashes);
    expect(v.unknown).toEqual([]);
    expect(v.hashMismatches).toEqual(['0026_contact_drop_legacy']);
  });
});

describe('upgradeRefusal', () => {
  it('refuses a pending train migration on a database with data', () => {
    expect(upgradeRefusal(journal, [1788400000000], true, false)).toEqual([
      '0023_drop_aggregator_profile',
      '0026_contact_drop_legacy',
      '0027_users',
    ]);
  });

  it('allows an empty database (fresh instance, CI)', () => {
    expect(upgradeRefusal(journal, [], false, false)).toEqual([]);
  });

  it('allows the dev override', () => {
    expect(upgradeRefusal(journal, [1788400000000], true, true)).toEqual([]);
  });

  it('never fires once the train is applied (later releases migrate at boot)', () => {
    const later: JournalEntry[] = [
      ...journal,
      { when: UPGRADE_LAST_WHEN + 100000000, tag: '0099_next' },
    ];
    expect(upgradeRefusal(later, [UPGRADE_LAST_WHEN], true, false)).toEqual([]);
  });

  it('refuses only the train part of a partially migrated database', () => {
    expect(
      upgradeRefusal(journal, [1788400000000, UPGRADE_FIRST_WHEN, 1790900000000], true, false),
    ).toEqual(['0027_users']);
  });
});

describe('runMigrationGuards (IO wrapper)', () => {
  /** A migrations folder holding `entries`, each file's content = its tag. */
  async function folder(entries: JournalEntry[]): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'mig-guard-'));
    await mkdir(path.join(dir, 'meta'));
    await writeFile(path.join(dir, 'meta/_journal.json'), JSON.stringify({ entries }));
    for (const e of entries) await writeFile(path.join(dir, `${e.tag}.sql`), e.tag);
    return dir;
  }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');

  /** A pg Pool fake answering the guard's three query shapes. */
  function pool(opts: { meta: boolean; applied: AppliedRow[]; dataIn: string[] }) {
    return {
      query: (text: string, params?: unknown[]) => {
        if (text.includes("to_regclass('drizzle.__drizzle_migrations')")) {
          return Promise.resolve({
            rows: [{ t: opts.meta ? 'drizzle.__drizzle_migrations' : null }],
          });
        }
        if (text.startsWith('SELECT created_at')) return Promise.resolve({ rows: opts.applied });
        if (text.startsWith('SELECT to_regclass($1)')) {
          return Promise.resolve({ rows: [{ t: String(params?.[0]) }] });
        }
        const table = /FROM (\w+)/.exec(text)?.[1] ?? '';
        return Promise.resolve({ rowCount: opts.dataIn.includes(table) ? 1 : 0, rows: [] });
      },
    } as never;
  }
  interface AppliedRow {
    created_at: string;
    hash: string;
  }

  const entries: JournalEntry[] = [
    { when: 1788400000000, tag: '0022_x' },
    { when: UPGRADE_LAST_WHEN, tag: '0027_users' },
  ];
  const at0022: AppliedRow[] = [{ created_at: '1788400000000', hash: hash('0022_x') }];

  it('does nothing on a brand-new database', async () => {
    const dir = await folder(entries);
    await expect(
      runMigrationGuards(pool({ meta: false, applied: [], dataIn: [] }), dir, false),
    ).resolves.toBeUndefined();
  });

  it('refuses the train on a database with data, unless overridden', async () => {
    const dir = await folder(entries);
    const p = pool({ meta: true, applied: at0022, dataIn: ['aggregators'] });
    await expect(runMigrationGuards(p, dir, false)).rejects.toThrow(/instance upgrade/);
    await expect(runMigrationGuards(p, dir, true)).resolves.toBeUndefined();
  });

  it('allows the train on an empty database', async () => {
    const dir = await folder(entries);
    await expect(
      runMigrationGuards(pool({ meta: true, applied: at0022, dataIn: [] }), dir, false),
    ).resolves.toBeUndefined();
  });

  it('refuses a foreign applied migration, tolerates it under the override', async () => {
    const dir = await folder(entries);
    const applied = [...at0022, { created_at: '1791000000000', hash: 'abandoned' }];
    const p = pool({ meta: true, applied, dataIn: [] });
    await expect(runMigrationGuards(p, dir, false)).rejects.toThrow(/not in this release/);
    await expect(runMigrationGuards(p, dir, true)).resolves.toBeUndefined();
  });

  it('only warns on a hash mismatch for a known migration', async () => {
    const dir = await folder(entries);
    const p = pool({
      meta: true,
      applied: [{ created_at: '1788400000000', hash: 'edited' }],
      dataIn: [],
    });
    await expect(runMigrationGuards(p, dir, false)).resolves.toBeUndefined();
  });
});

describe('train bounds vs the shipped journal', () => {
  it('cover every migration from 0023 to 0029, the end of the instance upgrade', async () => {
    const journalPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../drizzle/migrations/meta/_journal.json',
    );
    const real = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: JournalEntry[] };
    const first = real.entries.find((e) => e.tag.startsWith('0023_'));
    expect(first?.when).toBe(UPGRADE_FIRST_WHEN);
    // The instance upgrade ends at 0029 (0028 and 0029 each moved
    // UPGRADE_LAST_WHEN). Later migrations (0030 RBAC) are additive and run at
    // boot; the upgrade tool also applies them when they ship together. A new
    // migration that restructures existing data must join the upgrade and move
    // UPGRADE_LAST_WHEN instead.
    const last = real.entries.find((e) => e.tag.startsWith('0029_'));
    expect(last?.when).toBe(UPGRADE_LAST_WHEN);
    for (const e of real.entries.filter((x) => x.when > UPGRADE_LAST_WHEN)) {
      expect(BOOT_SAFE_AFTER_UPGRADE).toContain(e.tag);
    }
  });
});
