/**
 * Unit tests for ConsentCheckboxWidget.
 *
 * Covers: clickable links opening the modal on the correct tab, checkbox value
 * toggling, plain-text fallback when no consent content is provided, and modal
 * close behaviour.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import type { ConsentDocContent } from '@/components/consent/consent-types';

// Mock ConsentModal so we don't need to render the heavy overlay in unit tests.
vi.mock('@/components/consent/ConsentModal', () => ({
  ConsentModal: ({
    open,
    initialTab,
    content,
    onOpenChange,
  }: {
    open: boolean;
    initialTab: string;
    content: unknown;
    onOpenChange: (v: boolean) => void;
  }) =>
    open ? (
      <div data-testid="consent-modal" data-tab={initialTab}>
        {JSON.stringify(content)}
        <button onClick={() => onOpenChange(false)}>close</button>
      </div>
    ) : null,
}));

// Mock MarkdownContent since it's only used inside ConsentModal (mocked above),
// but include it here to prevent react-markdown from needing an environment.
vi.mock('@/components/forms/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { ConsentCheckboxWidget } from '@/components/forms/ConsentCheckboxWidget';

const sampleContent: ConsentDocContent = {
  terms: { version: 1, title: 'Terms of Service', content: '# Terms' },
  privacy: { version: 1, title: 'Privacy Policy', content: '# Privacy' },
};

/**
 * Minimal RJSF WidgetProps-compatible object for direct rendering.
 *
 * RJSF v6 moved `formContext` off the top-level widget props and onto
 * `registry`, so the `formContext` argument is nested under `registry` here —
 * where the widget now reads it — while call sites keep passing it flat.
 */
function makeProps({
  formContext = {},
  ...overrides
}: Record<string, unknown> & { formContext?: Record<string, unknown> } = {}) {
  return {
    id: 'consent-checkbox',
    value: false,
    required: true,
    disabled: false,
    readonly: false,
    onChange: vi.fn(),
    label: 'Consent',
    schema: {},
    options: {},
    uiSchema: {},
    registry: { formContext } as never,
    rawErrors: [],
    ...overrides,
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

describe('ConsentCheckboxWidget', () => {
  it('renders Terms of Service and Privacy Policy buttons when consentContent is provided', () => {
    render(
      <Wrapper>
        <ConsentCheckboxWidget
          {...(makeProps({ formContext: { consentContent: sampleContent } }) as never)}
        />
      </Wrapper>,
    );

    expect(screen.getByRole('button', { name: 'Terms of Service' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Privacy Policy' })).toBeInTheDocument();
  });

  it('clicking Terms of Service opens the modal on the terms tab', () => {
    render(
      <Wrapper>
        <ConsentCheckboxWidget
          {...(makeProps({ formContext: { consentContent: sampleContent } }) as never)}
        />
      </Wrapper>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Terms of Service' }));

    const modal = screen.getByTestId('consent-modal');
    expect(modal).toBeInTheDocument();
    expect(modal.getAttribute('data-tab')).toBe('terms');
  });

  it('clicking Privacy Policy opens the modal on the privacy tab', () => {
    render(
      <Wrapper>
        <ConsentCheckboxWidget
          {...(makeProps({ formContext: { consentContent: sampleContent } }) as never)}
        />
      </Wrapper>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Privacy Policy' }));

    const modal = screen.getByTestId('consent-modal');
    expect(modal).toBeInTheDocument();
    expect(modal.getAttribute('data-tab')).toBe('privacy');
  });

  it('checkbox change calls onChange with the new boolean value', () => {
    const onChange = vi.fn();
    render(
      <Wrapper>
        <ConsentCheckboxWidget
          {...(makeProps({ formContext: { consentContent: sampleContent }, onChange }) as never)}
        />
      </Wrapper>,
    );

    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('closes the modal when the close button is clicked', () => {
    render(
      <Wrapper>
        <ConsentCheckboxWidget
          {...(makeProps({ formContext: { consentContent: sampleContent } }) as never)}
        />
      </Wrapper>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Terms of Service' }));
    expect(screen.getByTestId('consent-modal')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'close' }));
    expect(screen.queryByTestId('consent-modal')).toBeNull();
  });

  it('degrades to plain text label when consentContent is not provided', () => {
    render(
      <Wrapper>
        <ConsentCheckboxWidget {...(makeProps() as never)} />
      </Wrapper>,
    );

    // No interactive buttons — links are not rendered without content.
    expect(screen.queryByRole('button', { name: 'Terms of Service' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Privacy Policy' })).toBeNull();

    // But the text is still present.
    expect(screen.getByText(/Terms of Service/)).toBeInTheDocument();
    expect(screen.getByText(/Privacy Policy/)).toBeInTheDocument();

    // Modal is never mounted without content.
    expect(screen.queryByTestId('consent-modal')).toBeNull();
  });
});
