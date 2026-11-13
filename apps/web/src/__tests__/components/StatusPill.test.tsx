import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { StatusPill } from '../../components/ui/StatusPill';
import type { ComponentProps } from 'react';

const messages = {
  status_pill: {
    active: 'Active',
    at_risk: 'At Risk',
    inactive: 'Inactive',
    satisfied: 'Satisfied',
    complete: 'Complete',
    incomplete: 'Incomplete',
  },
};

function renderPill(status: ComponentProps<typeof StatusPill>['status']) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StatusPill status={status} />
    </NextIntlClientProvider>,
  );
}

describe('<StatusPill />', () => {
  it('renders the active label', () => {
    renderPill('active');
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders an at-risk label', () => {
    renderPill('at-risk');
    expect(screen.getByText('At Risk')).toBeInTheDocument();
  });

  it('renders complete and incomplete labels', () => {
    renderPill('complete');
    expect(screen.getByText('Complete')).toBeInTheDocument();
    renderPill('incomplete');
    expect(screen.getByText('Incomplete')).toBeInTheDocument();
  });

  it('renders the inactive and satisfied labels', () => {
    renderPill('inactive');
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    renderPill('satisfied');
    expect(screen.getByText('Satisfied')).toBeInTheDocument();
  });

  it('falls back to the inactive style/label for an unrecognised status', () => {
    // Simulates upstream data drifting from the known status union — the `??`
    // fallback in the component must degrade gracefully rather than throw.
    renderPill('unknown-status' as unknown as ComponentProps<typeof StatusPill>['status']);
    expect(screen.getByText('Inactive')).toBeInTheDocument();
  });

  it('renders a pulsing indicator only for the at-risk status', () => {
    const { container: atRisk } = renderPill('at-risk');
    expect(atRisk.querySelector('.animate-pulse-dot')).toBeInTheDocument();

    const { container: active } = renderPill('active');
    expect(active.querySelector('.animate-pulse-dot')).toBeNull();
  });
});
