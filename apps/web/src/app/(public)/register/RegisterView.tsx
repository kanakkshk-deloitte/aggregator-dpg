'use client';

import { type JSX } from 'react';
import { useTranslations } from 'next-intl';
import type { RJSFSchema } from '@rjsf/utils';
import { RegisterPageShell } from './RegisterPageShell';
import { CoordinatorRegisterForm } from './CoordinatorRegisterForm';
import type { ConsentDocContent } from '../../../components/consent/consent-types';

export interface RegisterViewProps {
  schema: RJSFSchema;
  uiSchema: Record<string, unknown>;
  /**
   * Terms/Privacy content for the coordinator form, passed to
   * {@link CoordinatorRegisterForm}. `null` when loading failed; the form then
   * shows an error on submit.
   */
  aggregatorConsentContent?: ConsentDocContent | null;
}

/**
 * Public coordinator registration page: the shared shell around the coordinator form.
 *
 * @param props - Coordinator schema/UI schema and the aggregator consent content.
 * @returns The registration page body.
 */
export function RegisterView({
  schema,
  uiSchema,
  aggregatorConsentContent,
}: Readonly<RegisterViewProps>): JSX.Element {
  const t = useTranslations('register');

  return (
    <RegisterPageShell heading={t('page_title')}>
      <CoordinatorRegisterForm
        schema={schema}
        uiSchema={uiSchema}
        {...(aggregatorConsentContent ? { consentContent: aggregatorConsentContent } : {})}
      />
    </RegisterPageShell>
  );
}
