import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import { ConsentProgressTracker } from '@/components/consent/ConsentProgressTracker';
import type { ConsentDoc } from '@/components/consent/consent-docs';

const docs: ConsentDoc[] = [
  { id: 'privacy', cap: 'Privacy', title: 'Privacy Policy', body: 'p' },
  { id: 'terms', cap: 'Terms', title: 'Terms of Service', body: 't' },
];

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

describe('<ConsentProgressTracker />', () => {
  it('marks the first document current and the rest todo at the start', () => {
    render(
      <Wrapper>
        <ConsentProgressTracker
          docs={docs}
          progress={{ readIds: [], currentId: 'privacy', fillPercent: 0, allRead: false }}
        />
      </Wrapper>,
    );
    expect(screen.getByTestId('consent-node-privacy')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('consent-node-terms')).toHaveAttribute('data-state', 'todo');
  });

  it('marks read documents read and reflects fill on the connecting line', () => {
    render(
      <Wrapper>
        <ConsentProgressTracker
          docs={docs}
          progress={{ readIds: ['privacy'], currentId: 'terms', fillPercent: 50, allRead: false }}
        />
      </Wrapper>,
    );
    expect(screen.getByTestId('consent-node-privacy')).toHaveAttribute('data-state', 'read');
    expect(screen.getByTestId('consent-node-terms')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('consent-progress-fill')).toHaveStyle({ width: '50%' });
  });

  it('renders nothing for a single document — a tracker of one conveys nothing', () => {
    const { container } = render(
      <Wrapper>
        <ConsentProgressTracker
          docs={[docs[0]!]}
          progress={{ readIds: [], currentId: 'privacy', fillPercent: 0, allRead: false }}
        />
      </Wrapper>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // The connecting line spans from the first dot's centre to the last dot's
  // centre. Each dot sits in its own `flex-1` node, so with `n` equal-width
  // nodes, node `i`'s centre (0-indexed) is at `(i + 0.5) / n`; the first
  // dot's centre is `0.5 / n` = `50 / n` percent from the left, and the last
  // dot's centre is the same distance from the right. A hardcoded `16.67%`
  // (`50 / 3`) is correct only for exactly three nodes; with two nodes the
  // true centres are at 25%/75%, so that hardcoded value overshoots both
  // dots. Ported from Signals commit 033d6315.
  describe('connecting line inset', () => {
    it('insets the line to the true dot centres for two documents (25%/75%)', () => {
      render(
        <Wrapper>
          <ConsentProgressTracker
            docs={docs}
            progress={{ readIds: [], currentId: 'privacy', fillPercent: 0, allRead: false }}
          />
        </Wrapper>,
      );
      // Pre-fix this was the hardcoded 16.67%, which overshoots both dots
      // when there are only two nodes.
      expect(screen.getByTestId('consent-progress-track')).toHaveStyle({
        left: '25%',
        right: '25%',
      });
    });

    it('insets the line to the true dot centres for three documents (unchanged)', () => {
      const threeDocs: ConsentDoc[] = [
        ...docs,
        { id: 'profile', cap: 'Profile', title: 'Profile creation', body: 'p' },
      ];
      render(
        <Wrapper>
          <ConsentProgressTracker
            docs={threeDocs}
            progress={{ readIds: [], currentId: 'privacy', fillPercent: 0, allRead: false }}
          />
        </Wrapper>,
      );
      expect(screen.getByTestId('consent-progress-track')).toHaveStyle({
        left: `${50 / 3}%`,
        right: `${50 / 3}%`,
      });
    });
  });

  it('prefers the consent_gate.cap_* translation over the doc.cap fallback', () => {
    // doc.cap is deliberately not the real label, so the assertion only
    // passes if the rendered text came from the translation key.
    const staleCap: ConsentDoc[] = [
      { id: 'privacy', cap: 'stale-fallback-label', title: 'Privacy Policy', body: 'p' },
      { id: 'terms', cap: 'Terms', title: 'Terms of Service', body: 't' },
    ];
    render(
      <Wrapper>
        <ConsentProgressTracker
          docs={staleCap}
          progress={{ readIds: [], currentId: 'privacy', fillPercent: 0, allRead: false }}
        />
      </Wrapper>,
    );
    expect(screen.getByTestId('consent-node-privacy')).toHaveTextContent(
      messages.consent_gate.cap_privacy,
    );
    expect(screen.queryByText('stale-fallback-label')).not.toBeInTheDocument();
  });
});
