/**
 * Builds the aggregator and organisation document groups for the `/legal` page.
 *
 * Participant documents are not shown here; participants see them in the
 * public registration form and in the Signals portal.
 *
 * Both groups load from one config call. A failure returns an empty list.
 *
 * @module apps/web/src/components/legal/load-legal-groups.server
 */
import 'server-only';
import { getTranslations } from 'next-intl/server';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';
import { logger } from '../../lib/logger';
import type { ConsentDocContent } from '../consent/consent-types';
import type { LegalGroup } from './LegalDocumentView';

/** Shape of one versioned document inside `loadConsentConfig`'s result. */
interface AudienceDoc {
  current_version: number;
  versions: Array<{ version: number; title: string; content: string; effective_from: string }>;
}

/**
 * Picks the current-version entry of an aggregator/org consent document.
 *
 * @param doc - The versioned document.
 * @returns The current version's content.
 * @throws {Error} If `current_version` has no matching entry.
 */
function pickCurrent(doc: AudienceDoc): ConsentDocContent['terms'] {
  const found = doc.versions.find((v) => v.version === doc.current_version);
  if (!found) throw new Error(`current_version ${doc.current_version} not found in versions`);
  return {
    version: found.version,
    title: found.title,
    content: found.content,
    effective_from: found.effective_from,
  };
}

/**
 * Loads the aggregator and org groups from the aggregator's `consent.json`.
 *
 * @param labels - Display labels for the two groups.
 * @returns Both groups, or an empty list when the config is missing or invalid.
 */
async function loadAggregatorOrgGroups(labels: {
  aggregator: string;
  org: string;
}): Promise<LegalGroup[]> {
  const network = process.env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = process.env.AGGREGATOR_BRAND?.trim() || undefined;
  try {
    const cfg = await loadConsentConfig(network, brand);
    return [
      {
        audience: 'aggregator',
        label: labels.aggregator,
        content: {
          terms: pickCurrent(cfg.audiences.aggregator.documents.terms),
          privacy: pickCurrent(cfg.audiences.aggregator.documents.privacy),
        },
      },
      {
        audience: 'org',
        label: labels.org,
        content: {
          terms: pickCurrent(cfg.audiences.org.documents.terms),
          privacy: pickCurrent(cfg.audiences.org.documents.privacy),
        },
      },
    ];
  } catch (err) {
    logger.warn({
      operation: 'loadLegalGroups',
      audience: 'aggregator+org',
      status: 'failure',
      error: err instanceof Error ? err.message : String(err),
      network,
      brand,
    });
    return [];
  }
}

/**
 * Loads the aggregator and org consent documents for `/legal`, in that order.
 *
 * @returns Both groups, or an empty list when the config failed to load.
 */
export async function loadLegalGroups(): Promise<LegalGroup[]> {
  const t = await getTranslations('legal');
  return loadAggregatorOrgGroups({
    aggregator: t('audience_aggregator'),
    org: t('audience_org'),
  });
}
