import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState, type ReactNode } from 'react';
import messages from '@/i18n/messages/en.json';
import { ConsentGate } from '@/components/consent/ConsentGate';
import type { ConsentDoc } from '@/components/consent/consent-docs';

const docs: ConsentDoc[] = [
  { id: 'privacy', cap: 'Privacy', title: 'Privacy Policy', body: 'Privacy body' },
  { id: 'terms', cap: 'Terms', title: 'Terms of Service', body: 'Terms body' },
];

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

/**
 * jsdom lays nothing out, so the gate would see a 0x0 scroller and treat it as
 * unscrollable (correctly — an unmeasurable box cannot be scrolled). To drive
 * the locked path we stub a taller-than-viewport scroller.
 *
 * Stubs `getBoundingClientRect`, not `offsetTop`/`offsetHeight`: the gate
 * shipped broken in production because `offsetTop` is relative to the
 * nearest *positioned* ancestor, not the scroller — here that ancestor was
 * the dialog panel several elements up, not `consent-reader` itself. A stub
 * expressed directly in the reader's content space (as `offsetTop`-based
 * stubs necessarily are) cannot fail the way the real DOM failed. Giving the
 * reader a non-zero, ancestor-independent viewport `top` — 149, the figure a
 * real Chromium reported for the sibling repo's equivalent markup — means a
 * regression back to `offsetTop`-style measurement fails this test rather
 * than passing it.
 */
const READER_VIEWPORT_TOP = 149;

function rect(top: number, height: number): DOMRect {
  return {
    top,
    height,
    bottom: top + height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function stubScroller(scrollHeight: number, clientHeight: number, scrollTop = 0) {
  const el = screen.getByTestId('consent-reader');
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
  el.getBoundingClientRect = () => rect(READER_VIEWPORT_TOP, clientHeight);
  for (const doc of docs) {
    const section = el.querySelector<HTMLElement>(`[data-consent-section="${doc.id}"]`)!;
    const top = doc.id === 'privacy' ? 0 : 300;
    // Recomputed against the reader's *current* scrollTop each call, the way
    // a real scrolling browser reports a child's viewport position — not a
    // static value pre-expressed in the reader's content space.
    section.getBoundingClientRect = () =>
      rect(READER_VIEWPORT_TOP + top - (el as unknown as { scrollTop: number }).scrollTop, 300);
  }
  return el;
}

// ResizeObserver is stubbed globally in src/__tests__/setup.ts.

describe('<ConsentGate />', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <Wrapper>
        <ConsentGate open={false} docs={docs} agreeLabel="I agree" onAccept={vi.fn()} />
      </Wrapper>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there are no documents to show', () => {
    const { container } = render(
      <Wrapper>
        <ConsentGate open docs={[]} agreeLabel="I agree" onAccept={vi.fn()} />
      </Wrapper>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps the checkbox and CTA locked until every document has been read', () => {
    render(
      <Wrapper>
        <ConsentGate open docs={docs} agreeLabel="I agree" onAccept={vi.fn()} />
      </Wrapper>,
    );
    const el = stubScroller(600, 200, 0);
    fireEvent.scroll(el);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Accept & continue' })).toBeDisabled();
    expect(screen.getByText('Keep reading to continue.')).toBeInTheDocument();
  });

  it('reaches allRead at max scroll even though the reader is not the positioned ancestor — the production defect', () => {
    // The gate shipped broken: sections were measured via `offsetTop`, which
    // is relative to the nearest *positioned* ancestor — the dialog panel,
    // several elements above the reader — not the reader itself. `viewBottom`
    // is in the reader's own scroll space, so the two were never comparable
    // and `allRead` could not be reached at any scroll position, on any
    // surface that uses this gate. `stubScroller`'s nonzero, ancestor-
    // independent `READER_VIEWPORT_TOP` reproduces that mismatch; this test
    // is the one that would have caught it.
    render(
      <Wrapper>
        <ConsentGate open docs={docs} agreeLabel="I agree" onAccept={vi.fn()} />
      </Wrapper>,
    );
    const el = stubScroller(600, 200, 400); // scrollTop + clientHeight === scrollHeight: max scroll
    fireEvent.scroll(el);
    expect(screen.getByRole('checkbox')).toBeEnabled();
  });

  it('unlocks the checkbox at the end, then the CTA once ticked', () => {
    const onAccept = vi.fn();
    render(
      <Wrapper>
        <ConsentGate open docs={docs} agreeLabel="I agree" onAccept={onAccept} />
      </Wrapper>,
    );
    const el = stubScroller(600, 200, 400);
    fireEvent.scroll(el);

    const box = screen.getByRole('checkbox');
    expect(box).toBeEnabled();
    expect(screen.getByText("That's everything — you can agree now.")).toBeInTheDocument();

    const cta = screen.getByRole('button', { name: 'Accept & continue' });
    expect(cta).toBeDisabled();
    fireEvent.click(box);
    expect(cta).toBeEnabled();
    fireEvent.click(cta);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it('treats content shorter than the viewport as read — the 111-character case', () => {
    render(
      <Wrapper>
        <ConsentGate
          open
          docs={[{ id: 'profile', cap: 'Profile', title: 'Profile creation', body: 'Short.' }]}
          agreeLabel="I agree"
          onAccept={vi.fn()}
        />
      </Wrapper>,
    );
    // jsdom performs no layout, so an un-stubbed reader reports 0x0 — which
    // computeReadProgress correctly treats as "not yet measured", not as
    // "shorter than the viewport" (see its own dedicated guard against that
    // ambiguity). To exercise the real-world case — a document that fits
    // without scrolling — we stub the one section as unscrollable, the same
    // way `stubScroller` does above (getBoundingClientRect, not offsetTop —
    // see the comment on `stubScroller`).
    const el = screen.getByTestId('consent-reader');
    Object.defineProperty(el, 'scrollHeight', { value: 100, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    el.getBoundingClientRect = () => rect(READER_VIEWPORT_TOP, 200);
    const section = el.querySelector<HTMLElement>('[data-consent-section="profile"]')!;
    section.getBoundingClientRect = () => rect(READER_VIEWPORT_TOP, 100);
    fireEvent.scroll(el);

    expect(screen.getByRole('checkbox')).toBeEnabled();
  });

  it('does not dismiss on Escape or backdrop click', () => {
    const onCancel = vi.fn();
    render(
      <Wrapper>
        <ConsentGate open docs={docs} agreeLabel="I agree" onAccept={vi.fn()} onCancel={onCancel} />
      </Wrapper>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTestId('consent-gate-backdrop'));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('moves focus into the dialog on open, to the close button when one exists', async () => {
    render(
      <Wrapper>
        <ConsentGate open docs={docs} agreeLabel="I agree" onAccept={vi.fn()} onCancel={vi.fn()} />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());
  });

  it('moves focus to the reader when there is no close button to land on', async () => {
    render(
      <Wrapper>
        <ConsentGate open docs={docs} agreeLabel="I agree" onAccept={vi.fn()} />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByTestId('consent-reader')).toHaveFocus());
  });

  // jsdom has no real focus-order / Tab-key manager (browsers implement tab
  // sequence traversal themselves; jsdom does not simulate it), so this
  // cannot assert actual keyboard reachability. It asserts the structural
  // facts the fix is made of: the reader stays in the tab sequence (a
  // positive tabIndex, not the -1 that silently drops it) and resolves to the
  // region role with a non-empty accessible name. Real reachability was
  // verified against Radix's source and an empirical probe in the sibling
  // Signals repo, not by this test.
  //
  // The role is asserted via `getByRole`, i.e. the *computed* role, not a
  // literal `role="region"` attribute: the reader is a `<section>`, which maps
  // to `region` implicitly — but only while it has an accessible name, so a
  // dropped `aria-label` fails this query rather than quietly downgrading the
  // element to a generic container.
  it('keeps the reader in the tab sequence with a non-empty accessible name', () => {
    render(
      <Wrapper>
        <ConsentGate open docs={docs} agreeLabel="I agree" onAccept={vi.fn()} />
      </Wrapper>,
    );
    const reader = screen.getByTestId('consent-reader');
    expect(reader).toHaveAttribute('tabIndex', '0');
    expect(reader.getAttribute('aria-label')?.trim()).not.toBe('');
    expect(screen.getByRole('region', { name: 'Terms and privacy documents' })).toBe(reader);
  });

  it('mounts closed, opens, and can be completed — the mount-timing regression', () => {
    // A harness that genuinely toggles `open`, unlike every other test in
    // this file (which renders `<ConsentGate open .../>` already mounted
    // open). `useReadProgress`'s mount effect only ever sees a non-null
    // `scrollRef.current` if the reader element exists at the moment that
    // effect first runs — this is the transition production actually goes
    // through on every surface, and the one a permanently-open render can
    // never exercise.
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open the gate
          </button>
          <ConsentGate open={open} docs={docs} agreeLabel="I agree" onAccept={vi.fn()} />
        </>
      );
    }
    render(
      <Wrapper>
        <Harness />
      </Wrapper>,
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'open the gate' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    const el = stubScroller(600, 200, 400); // scrollTop + clientHeight === scrollHeight
    fireEvent.scroll(el);

    expect(screen.getByRole('checkbox')).toBeEnabled();
  });

  it('calls onCancel from the explicit close button only', () => {
    const onCancel = vi.fn();
    render(
      <Wrapper>
        <ConsentGate open docs={docs} agreeLabel="I agree" onAccept={vi.fn()} onCancel={onCancel} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
