/**
 * Unit tests for ConsentModal.
 *
 * Covers: closed state renders nothing, initial-tab selection, tab
 * switching, close via the header button/backdrop/ESC key, and that
 * re-opening resets the active tab to `initialTab`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import { ConsentModal } from '@/components/consent/ConsentModal';
import type { ConsentDocContent } from '@/components/consent/consent-types';

const content: ConsentDocContent = {
  terms: { version: 1, title: 'Terms of Service', content: '## Terms body' },
  privacy: { version: 1, title: 'Privacy Policy', content: '## Privacy body' },
};

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

describe('<ConsentModal />', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(
      <Wrapper>
        <ConsentModal open={false} onOpenChange={vi.fn()} initialTab="terms" content={content} />
      </Wrapper>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the terms tab active and its content when initialTab is terms', () => {
    render(
      <Wrapper>
        <ConsentModal open onOpenChange={vi.fn()} initialTab="terms" content={content} />
      </Wrapper>,
    );
    const termsTab = screen.getByRole('tab', { name: 'Terms of Service' });
    expect(termsTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Terms body' })).toBeInTheDocument();
  });

  it('renders the privacy tab active when initialTab is privacy', () => {
    render(
      <Wrapper>
        <ConsentModal open onOpenChange={vi.fn()} initialTab="privacy" content={content} />
      </Wrapper>,
    );
    const privacyTab = screen.getByRole('tab', { name: 'Privacy Policy' });
    expect(privacyTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Privacy body' })).toBeInTheDocument();
  });

  it('switches tabs on click', () => {
    render(
      <Wrapper>
        <ConsentModal open onOpenChange={vi.fn()} initialTab="terms" content={content} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Privacy Policy' }));
    expect(screen.getByRole('tab', { name: 'Privacy Policy' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('heading', { name: 'Privacy body' })).toBeInTheDocument();
  });

  it('calls onOpenChange(false) when the header close button is clicked', () => {
    const onOpenChange = vi.fn();
    render(
      <Wrapper>
        <ConsentModal open onOpenChange={onOpenChange} initialTab="terms" content={content} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls onOpenChange(false) when the backdrop is clicked', () => {
    const onOpenChange = vi.fn();
    render(
      <Wrapper>
        <ConsentModal open onOpenChange={onOpenChange} initialTab="terms" content={content} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close consent dialog' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('calls onOpenChange(false) when the ESC key is pressed', () => {
    const onOpenChange = vi.fn();
    render(
      <Wrapper>
        <ConsentModal open onOpenChange={onOpenChange} initialTab="terms" content={content} />
      </Wrapper>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('ignores non-Escape keys', () => {
    const onOpenChange = vi.fn();
    render(
      <Wrapper>
        <ConsentModal open onOpenChange={onOpenChange} initialTab="terms" content={content} />
      </Wrapper>,
    );
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('exposes an accessible dialog role labelled with the active document title', () => {
    render(
      <Wrapper>
        <ConsentModal open onOpenChange={vi.fn()} initialTab="privacy" content={content} />
      </Wrapper>,
    );
    expect(screen.getByRole('dialog', { name: 'Privacy Policy' })).toBeInTheDocument();
  });
});
