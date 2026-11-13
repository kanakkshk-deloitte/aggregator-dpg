'use client';

import { useMemo, type JSX } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import type { RJSFSchema } from '@rjsf/utils';
import { RegisterPageShell } from '../RegisterPageShell';
import { CoordinatorRegisterForm } from '../CoordinatorRegisterForm';
import { jsonFetch } from '../../../../services/http';
import type { ConsentDocContent } from '../../../../components/consent/consent-types';

export interface CoordinatorInviteViewProps {
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
  /** Raw invite JWT from the deep-link query string. */
  inviteToken: string;
  /** Versioned Terms/Privacy content for the coordinator (aggregator) form. */
  aggregatorConsentContent?: ConsentDocContent | null;
}

interface InviteClaims {
  org: string;
  email: string;
  exp: number;
}

interface OrgOption {
  id: string;
  slug: string;
  display_name: string;
}

/**
 * Decodes a JWT payload without verifying it, for display only.
 *
 * The server verifies the token on submit.
 *
 * @param token - The raw JWT.
 * @returns The invite claims, or `null` if the token can't be decoded.
 */
function decodeInviteClaims(token: string): InviteClaims | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replaceAll('-', '+').replaceAll('_', '/');
    const json = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    const claims = JSON.parse(json) as Partial<InviteClaims>;
    if (typeof claims.org !== 'string' || typeof claims.email !== 'string') return null;
    return { org: claims.org, email: claims.email, exp: Number(claims.exp) || 0 };
  } catch {
    return null;
  }
}

/**
 * Coordinator invite landing view.
 *
 * Decodes the invite, looks up the org name from `/api/orgs`, and renders the
 * coordinator form with the org fixed and the email prefilled. Invalid, expired,
 * or unknown-org tokens show a message pointing to sign-in. The submit endpoint
 * does the real check.
 *
 * @param props - Coordinator schema/UI schema, the invite token, consent content.
 * @returns The coordinator invite page body.
 */
export function CoordinatorInviteView({
  schema,
  uiSchema,
  inviteToken,
  aggregatorConsentContent,
}: Readonly<CoordinatorInviteViewProps>): JSX.Element {
  const t = useTranslations('register');
  const claims = useMemo(() => decodeInviteClaims(inviteToken), [inviteToken]);
  const expired = claims !== null && claims.exp > 0 && claims.exp * 1000 < Date.now();

  const orgsQuery = useQuery({
    queryKey: ['active-orgs'],
    queryFn: () => jsonFetch<{ orgs: OrgOption[] }>('/api/orgs'),
    enabled: claims !== null && !expired,
    staleTime: 30_000,
  });
  const org = orgsQuery.data?.orgs.find((o) => o.id === claims?.org);

  if (claims === null) {
    return (
      <RegisterPageShell heading="Invitation">
        <Notice>
          This invitation link is not valid. Please use the link from your invitation email, or{' '}
          <Link href="/login" className="font-semibold text-(--bd-primary-600) hover:underline">
            sign in
          </Link>{' '}
          if you already have an account.
        </Notice>
      </RegisterPageShell>
    );
  }

  if (expired) {
    return (
      <RegisterPageShell heading="Invitation expired">
        <Notice>
          This invitation has expired. Ask your organisation owner to send you a fresh invite, or{' '}
          <Link href="/login" className="font-semibold text-(--bd-primary-600) hover:underline">
            sign in
          </Link>{' '}
          if you already registered.
        </Notice>
      </RegisterPageShell>
    );
  }

  if (orgsQuery.isLoading) {
    return (
      <RegisterPageShell heading="Accept your invitation">
        <p className="mt-6 text-[14px] text-ink-500">Loading your invitation…</p>
      </RegisterPageShell>
    );
  }

  if (!org) {
    // Org is not in the active list; the server would reject a submit.
    return (
      <RegisterPageShell heading="Invitation unavailable">
        <Notice>
          This invitation can&apos;t be used right now. Please contact your organisation owner, or{' '}
          <Link href="/login" className="font-semibold text-(--bd-primary-600) hover:underline">
            sign in
          </Link>
          .
        </Notice>
      </RegisterPageShell>
    );
  }

  return (
    <RegisterPageShell heading={t('page_title')} tagline={null}>
      <CoordinatorRegisterForm
        schema={schema}
        uiSchema={uiSchema}
        inviteToken={inviteToken}
        lockedOrgName={org.display_name}
        lockedEmail={claims.email}
        {...(aggregatorConsentContent ? { consentContent: aggregatorConsentContent } : {})}
      />
    </RegisterPageShell>
  );
}

function Notice({
  children,
}: Readonly<{ children: JSX.Element | string | (JSX.Element | string)[] }>): JSX.Element {
  return (
    <output className="mt-6 block rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13.5px] text-amber-800">
      {children}
    </output>
  );
}
