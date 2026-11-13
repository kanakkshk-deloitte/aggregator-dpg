import type { JSX } from 'react';
import { loadBulkAttestation } from '../../../../lib/bulk-attestation.server';
import { BulkUploadsClient } from '../_components/BulkUploadsClient';

/**
 * Bulk-uploads page (Server Component).
 *
 * Loads the operator attestation text on the server and passes it to the client body.
 */
export default async function BulkUploadsPage(): Promise<JSX.Element> {
  const attestation = await loadBulkAttestation();
  return <BulkUploadsClient attestation={attestation} />;
}
