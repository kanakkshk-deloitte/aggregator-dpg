/**
 * Server-side loader for the bulk-upload operator attestation statement.
 *
 * Reads `audiences.aggregator.documents.bulk_upload_attestation` from the
 * operator `consent.json` via `@aggregator-dpg/config-loader/fs`, with no API
 * call. The version shown is for display only; the API records the
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
 * network/brand. Never throws.
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
