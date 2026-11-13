/**
 * Runs the org-owner name backfill for the `contact` table (api app script).
 *
 * Run once per existing instance after migration 0025, from a checkout (the api image has no tsx):
 *
 *   DATABASE_URL=… KEYCLOAK_URL=… KEYCLOAK_REALM=… \
 *   KEYCLOAK_ADMIN_CLIENT_ID=… KEYCLOAK_ADMIN_CLIENT_SECRET=… \
 *     pnpm --filter @aggregator-dpg/api exec tsx scripts/backfill-owner-contact-names.ts [--dry-run]
 *
 * Prints outcome counts only. Then check `scripts/sql/contact-verify.sql` V5.
 */
import '../src/env.js';
import { closeDb } from '../src/db/client.js';
import { getIdpAdmin } from '../src/services/idp-admin/index.js';
import { logger } from '../src/logger.js';
import {
  backfillOwnerContactNames,
  listOwnerNameCandidatesFromDb,
  setContactNameIfMissingInDb,
} from '../src/services/owner-name-backfill.js';

const dryRun = process.argv.includes('--dry-run');

try {
  const report = await backfillOwnerContactNames(
    {
      idp: getIdpAdmin(),
      listCandidates: listOwnerNameCandidatesFromDb,
      setNameIfMissing: setContactNameIfMissingInDb,
    },
    { dryRun },
  );
  logger.info(
    { operation: 'ownerNameBackfill', status: 'success', ...report },
    'owner-name backfill finished',
  );
  await closeDb();
  process.exit(report.failed > 0 ? 1 : 0);
} catch (err: unknown) {
  logger.error({
    operation: 'ownerNameBackfill',
    status: 'failure',
    error: (err as Error).message,
    error_type: (err as Error).constructor?.name,
  });
  await closeDb().catch(() => undefined);
  process.exit(1);
}
