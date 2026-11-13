import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getSession } from '../../../../lib/server-session';
import { OwnerRegisterView } from './OwnerRegisterView';
import { loadConsentContent, loadOrgSchema } from '../register-server';

export const metadata: Metadata = {
  title: 'Register as Aggregator Owner',
};

export const dynamic = 'force-dynamic';

/**
 * Owner (organisation) registration page, reachable only by direct URL or QR.
 *
 * An active session redirects to the dashboard. A missing org schema returns
 * `notFound()`. Otherwise it renders the owner form.
 */
export default async function OwnerRegisterPage() {
  const session = await getSession();
  if (session) redirect('/dashboard');

  const [org, consentContent] = await Promise.all([loadOrgSchema(), loadConsentContent()]);
  if (!org) notFound();

  return (
    <OwnerRegisterView
      schema={org.schema}
      uiSchema={org.uiSchema}
      orgConsentContent={consentContent?.org ?? null}
    />
  );
}
