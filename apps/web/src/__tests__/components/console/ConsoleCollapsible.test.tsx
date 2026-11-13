/**
 * Unit tests for ConsoleCollapsible.
 *
 * Covers: closed by default with title and hint visible, and opening on a
 * click on the header.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { ConsoleCollapsible } from '@/components/console/ConsoleUi';

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ConsoleCollapsible title="Levels" hint="3 levels below the network">
        <p>Level details</p>
      </ConsoleCollapsible>
    </NextIntlClientProvider>,
  );
}

describe('<ConsoleCollapsible />', () => {
  it('starts closed, showing the title and hint', () => {
    const { container } = renderSection();
    const details = container.querySelector('details');
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByRole('heading', { name: 'Levels' })).toBeInTheDocument();
    expect(screen.getByText('3 levels below the network')).toBeInTheDocument();
  });

  it('opens on a click on the header', () => {
    const { container } = renderSection();
    fireEvent.click(screen.getByText('Levels'));
    expect(container.querySelector('details')).toHaveAttribute('open');
    expect(screen.getByText('Level details')).toBeVisible();
  });
});
