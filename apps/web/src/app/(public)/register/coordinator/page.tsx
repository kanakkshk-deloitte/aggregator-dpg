import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '../../../../lib/server-session';
import { loadRegistrationSchema } from '../../../../lib/aggregator-schema.server';
import { loadConsentContent } from '../register-server';
import { CoordinatorInviteView } from './CoordinatorInviteView';

export const metadata: Metadata = {
  title: 'Accept your invitation',
};

export const dynamic = 'force-dynamic';

interface CoordinatorInvitePageProps {
  searchParams: Promise<{ invite?: string }>;
}

/**
 * Coordinator invite landing page: `/register/coordinator?invite=<jwt>`.
 *
 * An active session redirects to the dashboard. A missing `invite` token
 * redirects to `/login`. The token is decoded in the browser for display only;
 * the submit endpoint verifies it, checks the email, and consumes the invite.
 */
export default async function CoordinatorInvitePage({
  searchParams,
}: Readonly<CoordinatorInvitePageProps>) {
  const session = await getSession();
  if (session) redirect('/dashboard');

  const { invite } = await searchParams;
  if (!invite) redirect('/login');

  const { schema, uiSchema } = await loadRegistrationSchema();
  const consentContent = await loadConsentContent();

  return (
    <CoordinatorInviteView
      schema={schema}
      uiSchema={uiSchema}
      inviteToken={invite}
      aggregatorConsentContent={consentContent?.aggregator ?? null}
    />
  );
}
