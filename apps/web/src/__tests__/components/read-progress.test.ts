import { describe, it, expect } from 'vitest';
import { renderHook, fireEvent } from '@testing-library/react';
import type { RefObject } from 'react';
import {
  computeReadProgress,
  initialProgress,
  useReadProgress,
} from '@/components/consent/read-progress';
import type { ConsentDoc } from '@/components/consent/consent-docs';

// Three 300px sections stacked in a 200px-tall viewport.
const sections = [
  { id: 'privacy', top: 0, height: 300 },
  { id: 'terms', top: 300, height: 300 },
  { id: 'profile', top: 600, height: 300 },
];
const scroll = (scrollTop: number) => ({ scrollTop, clientHeight: 200, scrollHeight: 900 });

describe('computeReadProgress', () => {
  it('marks nothing read at the top and makes the first section current', () => {
    const p = computeReadProgress(scroll(0), sections, []);
    expect(p.readIds).toEqual([]);
    expect(p.currentId).toBe('privacy');
    expect(p.allRead).toBe(false);
  });

  it('marks a section read once its bottom passes the viewport bottom', () => {
    // viewport bottom = 100 + 200 = 300 === privacy bottom
    const p = computeReadProgress(scroll(100), sections, []);
    expect(p.readIds).toEqual(['privacy']);
    expect(p.currentId).toBe('terms');
  });

  it('advances fill continuously through the section in hand', () => {
    // privacy read (1 of 2 segments = 50%), halfway through terms adds 25%
    const p = computeReadProgress(scroll(250), sections, []);
    expect(p.readIds).toEqual(['privacy']);
    expect(p.fillPercent).toBeGreaterThan(50);
    expect(p.fillPercent).toBeLessThan(100);
  });

  it('reports every section read and 100% fill at the bottom', () => {
    const p = computeReadProgress(scroll(700), sections, []);
    expect(p.readIds).toEqual(['privacy', 'terms', 'profile']);
    expect(p.currentId).toBeNull();
    expect(p.allRead).toBe(true);
    expect(p.fillPercent).toBe(100);
  });

  it('keeps sections read after scrolling back up', () => {
    const p = computeReadProgress(scroll(0), sections, ['privacy', 'terms']);
    expect(p.readIds).toEqual(['privacy', 'terms']);
    expect(p.currentId).toBe('profile');
  });

  it('treats unscrollable content as fully read — the 111-character case', () => {
    const short = [{ id: 'profile', top: 0, height: 40 }];
    const p = computeReadProgress({ scrollTop: 0, clientHeight: 200, scrollHeight: 40 }, short, []);
    expect(p.allRead).toBe(true);
    expect(p.readIds).toEqual(['profile']);
  });

  it('reports allRead for an empty document list rather than blocking forever', () => {
    const p = computeReadProgress(scroll(0), [], []);
    expect(p.allRead).toBe(true);
    expect(p.currentId).toBeNull();
  });

  it('treats an unmeasured 0x0 container as nothing-read, not everything-read', () => {
    const p = computeReadProgress({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 }, sections, []);
    expect(p.allRead).toBe(false);
    expect(p.readIds).toEqual([]);
    expect(p.currentId).toBe('privacy');
  });

  // computeReadProgress derives its output readIds by filtering `sections`
  // (`sections.filter((s) => read.has(s.id))`), so a section absent from that
  // call's `sections` array is correctly absent from the output — the pure
  // function has nothing to say about a section it was never shown. That is
  // fine and expected; it is not where the sticky-read guarantee lives.
  it("drops a section from its output readIds when that call's sections omit it, even though it was already read — by design", () => {
    const short = [sections[1]!]; // 'terms' only; 'privacy' section missing this call
    const p = computeReadProgress(scroll(0), short, ['privacy']);
    expect(p.readIds).toEqual([]);
  });

  // The gap model (N-1 segments between N dots) degenerates at exactly two
  // documents: with one gap, `readIds.length / segments` already reads 1/1 =
  // 100% the instant the FIRST document finishes reading — before a single
  // pixel of the second has been shown. Three of this repo's four consent
  // surfaces (org registration, coordinator registration, the account-only
  // QR gate) show exactly privacy + terms, so this is the common case, not an
  // edge case. Ported from Signals commit 033d6315.
  describe('exactly two documents (privacy + terms)', () => {
    // Two 300px sections stacked in a 200px-tall viewport — the same shape
    // as the three-section fixture above, minus 'profile'.
    const twoSections = [
      { id: 'privacy', top: 0, height: 300 },
      { id: 'terms', top: 300, height: 300 },
    ];
    const twoScroll = (scrollTop: number) => ({ scrollTop, clientHeight: 200, scrollHeight: 600 });

    it('does not claim completion the instant the first of two documents is read', () => {
      // viewport bottom = 100 + 200 = 300 === privacy's bottom: privacy just
      // finished, not one pixel of terms has been shown yet.
      const p = computeReadProgress(twoScroll(100), twoSections, []);
      expect(p.readIds).toEqual(['privacy']);
      expect(p.currentId).toBe('terms');
      // Pre-fix this read 100 (1 read / 1 segment): claiming complete while
      // the reader is exactly halfway through the whole stack.
      expect(p.fillPercent).toBe(50);
    });

    it('advances fill continuously through the second of two documents', () => {
      // privacy read (1 of 2 segments = 50%), halfway through terms adds 25%.
      const p = computeReadProgress(twoScroll(250), twoSections, []);
      expect(p.readIds).toEqual(['privacy']);
      expect(p.fillPercent).toBe(75);
    });

    it('reports every section read and 100% fill at the bottom of two documents', () => {
      const p = computeReadProgress(twoScroll(400), twoSections, []);
      expect(p.readIds).toEqual(['privacy', 'terms']);
      expect(p.allRead).toBe(true);
      expect(p.fillPercent).toBe(100);
    });
  });

  // Regression pin: the two-document fix must not alter the three-document
  // (and up) fill trajectory. Widening the denominator to `sections.length`
  // unconditionally would change this repo's QR full form (privacy + terms +
  // profile) from the gap model's 75% to a whole-count model's 50% at this
  // exact scroll position — a real behaviour change this repo does not want.
  describe('three or more documents — unchanged by the two-document fix', () => {
    it('reports exactly 75% fill at one-of-three-read, halfway through the second', () => {
      // Same scenario as 'advances fill continuously through the section in
      // hand' above, pinned to its precise value rather than a range.
      const p = computeReadProgress(scroll(250), sections, []);
      expect(p.readIds).toEqual(['privacy']);
      expect(p.fillPercent).toBe(75);
    });

    it('reports exactly 100% fill when all three documents are read', () => {
      const p = computeReadProgress(scroll(700), sections, []);
      expect(p.fillPercent).toBe(100);
    });
  });
});

// A pure-function test on computeReadProgress cannot catch a bug in the
// hook's *bootstrap* state — render() from React Testing Library flushes
// effects inside act() before returning, so the pre-effect value is never
// observable through the hook either. initialProgress is extracted so the
// bootstrap value itself is directly assertable.
describe('initialProgress', () => {
  const docs: ConsentDoc[] = [
    { id: 'privacy', cap: 'Privacy', title: 'Privacy Policy', body: 'p' },
    { id: 'terms', cap: 'Terms', title: 'Terms of Service', body: 't' },
  ];

  it('reports nothing read for a non-empty document list — an unmeasured gate must never look done', () => {
    const p = initialProgress(docs);
    expect(p.allRead).toBe(false);
    expect(p.readIds).toEqual([]);
    expect(p.currentId).toBe('privacy');
  });

  it('reports allRead for an empty document list so it still cannot block forever', () => {
    const p = initialProgress([]);
    expect(p.allRead).toBe(true);
    expect(p.currentId).toBeNull();
  });
});

// The sticky-read guarantee ("scrolling back up cannot un-read a document")
// is bookkeeping the *hook* owns, not something computeReadProgress can
// enforce on its own — it only sees whatever `sections` the hook hands it on
// a given call. Pinned here, not in the computeReadProgress suite above.
describe('useReadProgress', () => {
  const docs: ConsentDoc[] = [
    { id: 'privacy', cap: 'Privacy', title: 'Privacy Policy', body: 'p' },
    { id: 'terms', cap: 'Terms', title: 'Terms of Service', body: 't' },
  ];

  // Non-zero and, deliberately, the exact figure a real Chromium reported for
  // the sibling Signals repo's equivalent markup (panel > header > tracker >
  // reader, reader with no `position: relative` of its own): the reader's own
  // viewport `top` is never 0 in production. A stub that used 0 here would
  // pass whether sections were measured from the reader or from the (also
  // top:0-in-jsdom) positioned ancestor several levels up — exactly the bug
  // that shipped. See `rect` below for why this file stubs
  // `getBoundingClientRect`, not `offsetTop`/`offsetHeight`.
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

  /** Builds the reader element's section children, optionally omitting one. */
  function setSections(el: HTMLElement, omit?: string) {
    el.innerHTML = '';
    // Section position in the scroller's CONTENT space (what the old, buggy
    // `offsetTop` conflated with "relative to the nearest positioned
    // ancestor"). The production code now derives this from a
    // getBoundingClientRect delta, so the honest stub here is
    // getBoundingClientRect too — one in viewport space, recomputed against
    // the reader's current `scrollTop` exactly as a real scrolling browser
    // would report it, not one pre-expressed in the implementation's own
    // content-space assumption.
    const contentOffsets: Record<string, { top: number; height: number }> = {
      privacy: { top: 0, height: 300 },
      terms: { top: 300, height: 300 },
    };
    for (const doc of docs) {
      if (doc.id === omit) continue;
      const section = document.createElement('div');
      section.setAttribute('data-consent-section', doc.id);
      const { top, height } = contentOffsets[doc.id]!;
      section.getBoundingClientRect = () => rect(READER_VIEWPORT_TOP + top - el.scrollTop, height);
      el.appendChild(section);
    }
  }

  function makeReader() {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { value: 600, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true, configurable: true });
    el.getBoundingClientRect = () => rect(READER_VIEWPORT_TOP, 200);
    setSections(el);
    return el;
  }

  it('keeps a document read even after its section transiently disappears from a later measurement', () => {
    const el = makeReader();
    const ref: RefObject<HTMLElement | null> = { current: el };
    const { result } = renderHook(() => useReadProgress(ref, docs));

    // 1. Scroll far enough that 'privacy' is read.
    (el as unknown as { scrollTop: number }).scrollTop = 100;
    fireEvent.scroll(el);
    expect(result.current.readIds).toContain('privacy');

    // 2. Simulate a remount/conditional render: privacy's DOM node briefly
    // vanishes from the reader while terms remains, at the same scroll spot.
    setSections(el, 'privacy');
    fireEvent.scroll(el);

    // 3. The node returns, but the reader has scrolled back to the very top
    // — a position that on its own would not qualify privacy as read.
    setSections(el);
    (el as unknown as { scrollTop: number }).scrollTop = 0;
    fireEvent.scroll(el);

    expect(result.current.readIds).toContain('privacy');
  });

  it('marks nothing read at the top even though the reader has a nonzero viewport offset', () => {
    // The mirror image of the test below: with the same nonzero
    // READER_VIEWPORT_TOP, an implementation that measured sections from the
    // wrong coordinate space could just as easily land on "everything looks
    // read immediately" as "nothing is ever readable" depending on exactly
    // how the mismatch resolves arithmetically — jsdom's real (unstubbed)
    // `offsetTop`/`offsetHeight` both default to 0, which satisfies
    // computeReadProgress's read check trivially at any scrollTop. This test
    // is what catches that failure mode; the one below alone would not have.
    const el = makeReader();
    const ref: RefObject<HTMLElement | null> = { current: el };
    const { result } = renderHook(() => useReadProgress(ref, docs));

    fireEvent.scroll(el); // scrollTop is still 0

    expect(result.current.readIds).toEqual([]);
    expect(result.current.allRead).toBe(false);
  });

  it('reaches allRead at max scroll when the reader is not the positioned ancestor — the production defect', () => {
    // This is the shape that shipped broken: the reader itself is not
    // `position: relative` (READER_VIEWPORT_TOP is nonzero and independent
    // of any ancestor), so a section's `offsetTop` would have been measured
    // from whatever positioned ancestor sits above the reader, not from the
    // reader's own scroll origin. `computeReadProgress` can only ever see
    // `allRead: true` if the hook feeds it a section `top` in the *reader's*
    // content space — which is exactly what a getBoundingClientRect delta
    // gives it and `offsetTop` does not.
    const el = makeReader();
    const ref: RefObject<HTMLElement | null> = { current: el };
    const { result } = renderHook(() => useReadProgress(ref, docs));

    (el as unknown as { scrollTop: number }).scrollTop = el.scrollHeight - el.clientHeight; // max scroll
    fireEvent.scroll(el);

    expect(result.current.allRead).toBe(true);
    expect(result.current.readIds).toEqual(['privacy', 'terms']);
  });

  it('does not report allRead before the first measurement has happened', () => {
    // Null ref: measure() and the mount effect both bail out, so setProgress never
    // fires and the hook is observed at its bootstrap value. With a real element,
    // RTL flushes the effect inside act() before renderHook returns and the
    // bootstrap value is already gone — which is why the bug this pins survived
    // review twice.
    const ref: RefObject<HTMLElement | null> = { current: null };
    const { result } = renderHook(() => useReadProgress(ref, docs));
    expect(result.current.allRead).toBe(false);
    expect(result.current.readIds).toEqual([]);
    expect(result.current.currentId).toBe('privacy');
  });

  it('reports allRead for a genuinely empty document list so it cannot deadlock', () => {
    const ref: RefObject<HTMLElement | null> = { current: null };
    const { result } = renderHook(() => useReadProgress(ref, []));
    expect(result.current.allRead).toBe(true);
  });
});
