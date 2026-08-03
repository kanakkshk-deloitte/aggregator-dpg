import { loadBulkAttestation } from '../../../../lib/bulk-attestation.server';
import { BulkUploadsClient } from '../_components/BulkUploadsClient';

/**
 * Bulk-uploads page (server component). Loads the operator attestation copy
 * server-side (no API round-trip, matching the registration consent flow) and
 * hands it to the client body for rendering in the upload form.
 */
export default async function BulkUploadsPage(): Promise<JSX.Element> {
  const attestation = await loadBulkAttestation();
  return <BulkUploadsClient attestation={attestation} />;
}
