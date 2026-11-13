/**
 * Unit tests for HierarchySettings: the shared section on the network admin's
 * and an owner's Organisations page.
 *
 * Covers: the title and description with the organisation's name, the current
 * values as pills (Aggregator when there are none), and the editor for the
 * organisation's values.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import type { KnownAsValues } from '@aggregator-dpg/shared-primitives/user-org';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { HierarchySettings } from '@/components/console/HierarchySettings';

const ORG = '00000000-0000-4000-8000-0000000000a0';
const VALUES: KnownAsValues = [
  { key: 'state', name: 'State', default: true },
  { key: 'partner', name: 'Partner' },
];

function renderIt(values: KnownAsValues = VALUES) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HierarchySettings orgId={ORG} orgName="Blue Dots Network" values={values} />
    </NextIntlClientProvider>,
  );
}

describe('<HierarchySettings />', () => {
  it('names the organisation the values are for', () => {
    renderIt();
    expect(screen.getByText(messages.console.orgs.hierarchy)).toBeInTheDocument();
    expect(
      screen.getByText('Choose what organisations directly under Blue Dots Network are called.'),
    ).toBeInTheDocument();
  });

  it('shows the current values as pills and edits them', () => {
    renderIt();
    expect(screen.getByText('State')).toBeInTheDocument();
    expect(screen.getByText('Partner')).toBeInTheDocument();
    expect(screen.getByDisplayValue('State')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Make State the default' })).toBeChecked();
  });

  it('shows the default first and folds values past three into "+N more"', () => {
    const many = ['Block', 'Ward', 'Zone', 'Taluk'].map((name) => ({
      key: name.toLowerCase(),
      name,
    }));
    renderIt([...many, { key: 'district', name: 'District', default: true }]);
    const more = screen.getByText('+2 more');
    expect(more).toHaveAttribute('title', 'Zone, Taluk');
    expect(more.parentElement?.textContent).toBe('Known asDistrictBlockWard+2 more');
  });

  it('shows Aggregator when there are no values', () => {
    renderIt([]);
    expect(screen.getByText(messages.console.org.known_as_values_fallback)).toBeInTheDocument();
    expect(screen.getByText(messages.console.org.known_as_values_empty)).toBeInTheDocument();
  });
});
