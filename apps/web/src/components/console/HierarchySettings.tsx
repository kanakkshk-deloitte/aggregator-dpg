/**
 * The hierarchy settings section: the "known as" values an organisation (or
 * the network) defines for the organisations directly under it. Used by both
 * the network admin's and an owner's Organisations page.
 */

import { useTranslations } from 'next-intl';
import type { KnownAsValues } from '@aggregator-dpg/shared-primitives/user-org';
import { ConsoleCollapsible } from './ConsoleUi';
import { KnownAsPills, KnownAsValuesEditor } from './KnownAsValuesEditor';

/**
 * Renders the section, closed by default.
 *
 * @param orgId - The organisation that defines the values (the root for the network).
 * @param orgName - Its name, shown in the description.
 * @param values - The saved values.
 */
export function HierarchySettings({
  orgId,
  orgName,
  values,
}: Readonly<{ orgId: string; orgName: string; values: KnownAsValues }>) {
  const t = useTranslations('console');
  return (
    <ConsoleCollapsible
      title={t('orgs.hierarchy')}
      description={t('orgs.hierarchy_description', { name: orgName })}
      hint={<KnownAsPills values={values} />}
      flush
    >
      <KnownAsValuesEditor orgId={orgId} values={values} />
    </ConsoleCollapsible>
  );
}
