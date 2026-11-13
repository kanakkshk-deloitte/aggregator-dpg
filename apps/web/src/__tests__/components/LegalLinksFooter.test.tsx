/**
 * Tests for the shared public-surface legal footer.
 *
 * The styling assertions are the point of the component: these links had been
 * muted prose that only announced themselves on hover — invisible as links on
 * a touch device, where there is no hover at all.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import { LegalLinksFooter } from '@/components/legal/LegalLinksFooter';

function renderFooter(variant: 'sentence' | 'separated') {
  return render(
    <NextIntlClientProvider locale="en" messages={messages as Record<string, ReactNode>}>
      <LegalLinksFooter variant={variant} />
    </NextIntlClientProvider>,
  );
}

describe('<LegalLinksFooter />', () => {
  it.each(['sentence', 'separated'] as const)(
    'points both links at the one legal page (%s)',
    (variant) => {
      renderFooter(variant);
      expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
        'href',
        '/legal#privacy',
      );
      expect(screen.getByRole('link', { name: /Terms/ })).toHaveAttribute('href', '/legal#terms');
    },
  );

  it.each(['sentence', 'separated'] as const)('makes them read as links (%s)', (variant) => {
    renderFooter(variant);
    for (const name of [/Privacy Policy/, /Terms/]) {
      const link = screen.getByRole('link', { name });
      // Underlined at rest, not only on hover, and carrying the brand colour.
      expect(link.className).toContain('underline');
      expect(link.className).not.toMatch(/hover:underline/);
      expect(link.className).toContain('text-(--bd-primary-600)');
    }
  });

  it('reads as a sentence, with the links inside it', () => {
    renderFooter('sentence');
    // The whole line, not fragments concatenated around the links — the copy
    // is one translated string so a language can place the links where its own
    // grammar needs them.
    expect(screen.getByText(/By continuing you agree to the/)).toHaveTextContent(
      'By continuing you agree to the Privacy Policy and Terms.',
    );
  });

  it('separates the two with a divider that screen readers skip', () => {
    const { container } = renderFooter('separated');
    const divider = container.querySelector('[aria-hidden="true"]');
    expect(divider).toHaveTextContent('·');
  });
});
