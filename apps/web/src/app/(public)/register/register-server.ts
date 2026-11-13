/**
 * Server-only helpers shared by `/register` and `/register/owner` for loading
 * the org schema and consent content.
 *
 * @module apps/web/src/app/(public)/register/register-server
 */

import 'server-only';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { logger } from '../../../lib/logger';
import type { ConsentDocContent } from '../../../components/consent/consent-types';

let legacyFlagWarned = false;

/**
 * Logs once per process when `ORG_HIERARCHY_ENABLED` is set. The variable has no effect.
 */
export function warnIfLegacyHierarchyFlag(): void {
  if (legacyFlagWarned || process.env.ORG_HIERARCHY_ENABLED === undefined) return;
  legacyFlagWarned = true;
  logger.warn(
    { operation: 'config.orgHierarchy', status: 'skipped' },
    'ORG_HIERARCHY_ENABLED is ignored — organisations are always on; remove it from the environment',
  );
}

/**
 * Loads the current consent documents for the `aggregator` and `org` audiences.
 *
 * @returns `aggregator` and `org` {@link ConsentDocContent}, or `null` if the
 *   config is missing or invalid.
 */
export async function loadConsentContent(): Promise<{
  aggregator: ConsentDocContent;
  org: ConsentDocContent;
} | null> {
  const network = process.env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = process.env.AGGREGATOR_BRAND?.trim() || undefined;
  try {
    const cfg = await loadConsentConfig(network, brand);

    const pickDoc = (doc: {
      current_version: number;
      versions: Array<{ version: number; title: string; content: string; effective_from: string }>;
    }): { version: number; title: string; content: string } => {
      const found = doc.versions.find((v) => v.version === doc.current_version);
      if (!found) throw new Error(`current_version ${doc.current_version} not found in versions`);
      return { version: found.version, title: found.title, content: found.content };
    };

    return {
      aggregator: {
        terms: pickDoc(cfg.audiences.aggregator.documents.terms),
        privacy: pickDoc(cfg.audiences.aggregator.documents.privacy),
      },
      org: {
        terms: pickDoc(cfg.audiences.org.documents.terms),
        privacy: pickDoc(cfg.audiences.org.documents.privacy),
      },
    };
  } catch (err) {
    logger.warn({
      operation: 'loadConsentContent',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof Error ? err.constructor.name : 'Unknown',
      network,
      brand,
    });
    return null;
  }
}

/**
 * Loads the org-registration JSON Schema + UI schema, with the network's
 * domains filled in.
 *
 * @returns The parsed org schema pair, or `null` if the files are absent or
 *   unreadable (the owner route then returns 404).
 */
export { loadOrgSchema } from '../../../lib/org-schema.server';
