/**
 * Authenticated aggregator profile page.
 *
 * Server Component: loads the same registration JSON Schema the public
 * `/register` page uses (single source of truth) and hands it to a read-only
 * client view. Per issue #470 the profile mirrors the registration form and
 * cannot be edited in place — update requests are handled out-of-band.
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
