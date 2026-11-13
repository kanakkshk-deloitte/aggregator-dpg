/**
 * Regression test for aggregator-dpg#617 (final-review cheap item):
 * `0022_campaign_pii_audit.sql`'s `CREATE TYPE` statements must be
 * schema-qualified (`"public"."name"`), matching every other hand-authored
 * migration in this repo (e.g. `0019_...sql`) — an unqualified `CREATE TYPE
 * "name"` still works (it resolves via `search_path`), but is inconsistent
 * with the rest of the migration history for no reason.
 *
 * Renumbered from 0021 to 0022 when merging `feature` (which landed
 * `0021_registration_invites` first) — see aggregator-dpg#729.
 *
 * @module apps/api/__tests__/migration-0022-schema-qualified
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/api/src/__tests__ -> repo root is four levels up.
const repoRoot = path.resolve(here, '../../../..');
const migrationsDir = path.join(repoRoot, 'apps', 'api', 'drizzle', 'migrations');

describe('0022_campaign_pii_audit.sql CREATE TYPE statements are schema-qualified', () => {
  it('every CREATE TYPE line names "public" explicitly', () => {
    const sql = readFileSync(path.join(migrationsDir, '0022_campaign_pii_audit.sql'), 'utf8');
    const createTypeLines = sql.split('\n').filter((l) => l.startsWith('CREATE TYPE'));
    expect(createTypeLines.length).toBeGreaterThan(0);
    for (const line of createTypeLines) {
      expect(line).toMatch(/^CREATE TYPE "public"\."/);
    }
  });

  it('matches the schema-qualification style already used by 0019 (no regression in the pattern)', () => {
    const sql0019 = readFileSync(path.join(migrationsDir, '0019_campaign_async_job.sql'), 'utf8');
    const referenceLines = sql0019.split('\n').filter((l) => l.startsWith('CREATE TYPE'));
    expect(referenceLines.length).toBeGreaterThan(0);
    for (const line of referenceLines) {
      expect(line).toMatch(/^CREATE TYPE "public"\./);
    }
  });
});
