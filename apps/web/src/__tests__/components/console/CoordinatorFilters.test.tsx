/**
 * Unit tests for CoordinatorFilters.
 *
 * Covers: the organisation filter only with more than one organisation, the
 * domain filter only with domains, current values selected, and a change
 * submitting without the "all" choices.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { CoordinatorFilters } from '@/components/console/CoordinatorFilters';

const orgs = [
  { id: 'k', name: 'Karnataka', label: 'Karnataka (State)' },
  { id: 'm', name: 'Mysuru', label: 'Karnataka › Mysuru (District)' },
];
const domains = [{ id: 'seeker', label: 'Seeker' }];

function renderFilters(over: Partial<Parameters<typeof CoordinatorFilters>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CoordinatorFilters
        action="/console/coordinators"
        values={{ orgId: '', status: '', serves: '' }}
        orgs={orgs}
        domains={domains}
        {...over}
      />
    </NextIntlClientProvider>,
  );
}

const c = messages.console.coordinators;

describe('<CoordinatorFilters />', () => {
  it('shows organisation, status and domain filters with the current values', () => {
    renderFilters({ values: { orgId: 'm', status: 'pending', serves: 'seeker' } });
    expect(screen.getByLabelText(c.org_filter)).toHaveValue('m');
    expect(screen.getByLabelText(c.status_filter)).toHaveValue('pending');
    expect(screen.getByLabelText(c.serves_filter)).toHaveValue('seeker');
  });

  it('hides the organisation filter for a single organisation and the domain filter without domains', () => {
    renderFilters({ orgs: [orgs[0]!], domains: [] });
    expect(screen.queryByLabelText(c.org_filter)).toBeNull();
    expect(screen.queryByLabelText(c.serves_filter)).toBeNull();
    expect(screen.getByLabelText(c.status_filter)).toBeInTheDocument();
  });

  it('submits on change, leaving out the "all" choices', () => {
    const submit = vi.fn();
    HTMLFormElement.prototype.requestSubmit = submit;
    renderFilters();
    fireEvent.change(screen.getByLabelText(c.org_filter), { target: { value: 'k' } });
    expect(submit).toHaveBeenCalled();
    expect(screen.getByLabelText(c.org_filter)).not.toBeDisabled();
    expect(screen.getByLabelText(c.status_filter)).toBeDisabled();
    expect(screen.getByLabelText(c.serves_filter)).toBeDisabled();
  });

  it('shows the new values when the page moves to other filters (Clear filters, a chip)', () => {
    const view = (values: { orgId: string; status: string; serves: string }) => (
      <NextIntlClientProvider locale="en" messages={messages}>
        <CoordinatorFilters
          action="/console/coordinators"
          values={values}
          orgs={orgs}
          domains={domains}
        />
      </NextIntlClientProvider>
    );
    const { rerender } = render(view({ orgId: 'm', status: 'active', serves: 'seeker' }));
    rerender(view({ orgId: '', status: '', serves: '' }));
    expect(screen.getByLabelText(c.org_filter)).toHaveValue('');
    expect(screen.getByLabelText(c.status_filter)).toHaveValue('');
    expect(screen.getByLabelText(c.serves_filter)).toHaveValue('');
    expect(screen.getByLabelText(c.status_filter)).not.toBeDisabled();
  });
});
