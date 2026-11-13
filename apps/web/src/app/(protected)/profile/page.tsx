/**
 * Authenticated aggregator profile page.
 *
 * Server Component that loads the registration JSON Schema used by `/register`
 * and passes it to a read-only client view.
 */

import type { Metadata } from 'next';
import { loadRegistrationSchema } from '../../../lib/aggregator-schema.server';
import { ProfileFormView } from './ProfileFormView';

export const metadata: Metadata = {
  title: 'Aggregator Profile',
};

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const { schema, uiSchema } = await loadRegistrationSchema();
  return <ProfileFormView schema={schema} uiSchema={uiSchema} />;
}
