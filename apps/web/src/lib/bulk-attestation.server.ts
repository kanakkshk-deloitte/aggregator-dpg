/**
 * Server-side loader for the bulk-upload operator attestation statement
 * (#522 Task 1).
 *
 * Read the same way the registration Terms/Privacy copy is read — server-side
 * via `@aggregator-dpg/config-loader/fs`, no API round-trip (see
 * apps/web/CLAUDE.md "Consent content has no API round-trip"). The statement
 * lives in the aggregator (operator) `consent.json` under
 * `audiences.aggregator.documents.bulk_upload_attestation`.
 *
 * The rendered version is display-only; the API re-reads + records the
 * authoritative version at `/start`.
 *
 * @module apps/web/src/lib/bulk-attestation.server
 */

import 'server-only';
import { loadConsentConfig } from '@aggregator-dpg/config-loader/fs';

/** Current-version attestation copy shown before a bulk upload. */
export interface BulkAttestationContent {
  version: number;
  title: string;
  content: string;
}

/**
 * Loads the current-version bulk-upload attestation statement for the active
 * network/brand. Returns null when unconfigured or the config can't be read —
 * the UI degrades to a generic checkbox label. Never throws.
 *
 * @returns The attestation `{ version, title, content }`, or null.
 */
export async function loadBulkAttestation(): Promise<BulkAttestationContent | null> {
  const network = process.env.AGGREGATOR_NETWORK?.trim() || 'blue_dot';
  const brand = process.env.AGGREGATOR_BRAND?.trim() || undefined;
  try {
    const cfg = await loadConsentConfig(network, brand);
    const doc = cfg.audiences.aggregator.documents.bulk_upload_attestation;
    if (!doc?.versions?.length) return null;
    const v = doc.versions.find((x) => x.version === doc.current_version) ?? doc.versions[0];
    if (!v) return null;
    return { version: v.version, title: v.title, content: v.content };
  } catch {
    return null;
  }
}
