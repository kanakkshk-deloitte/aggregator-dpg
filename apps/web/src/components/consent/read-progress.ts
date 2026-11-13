'use client';
/**
 * Scroll-gating logic for the consent gate.
 *
 * All decisions live in the pure function {@link computeReadProgress}, so they
 * can be tested without layout. The hook only measures and delegates.
 *
 * @module apps/web/src/components/consent/read-progress
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ConsentDoc } from './consent-docs';

/**
 * Tolerance for scroll offset comparisons, in CSS pixels. Fractional pixel
 * ratios and iOS overscroll can leave the bottom a pixel short.
 */
const TOLERANCE = 8;

/** Geometry of one document section within the scroll container. */
export interface SectionBox {
  id: string;
  top: number;
  height: number;
}

/** Geometry of the scroll container itself. */
export interface ScrollBox {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** How much of the consent stack the reader has got through. */
export interface ReadProgress {
  readIds: string[];
  currentId: string | null;
  fillPercent: number;
  allRead: boolean;
}

/**
 * Decides which documents have been read, which is in hand, and how far the
 * tracker's line should extend.
 *
 * @param scroll - Scroll container geometry.
 * @param sections - Section geometry, in document order.
 * @param alreadyRead - Ids already read; never dropped.
 * @returns Progress across the whole stack.
 */
export function computeReadProgress(
  scroll: ScrollBox,
  sections: SectionBox[],
  alreadyRead: readonly string[],
): ReadProgress {
  if (sections.length === 0) {
    return { readIds: [], currentId: null, fillPercent: 100, allRead: true };
  }

  // An unmeasured (0x0) container must not count as unscrollable.
  if (scroll.clientHeight === 0 || scroll.scrollHeight === 0) {
    const readIds = sections.filter((s) => alreadyRead.includes(s.id)).map((s) => s.id);
    return {
      readIds,
      currentId: sections.find((s) => !readIds.includes(s.id))?.id ?? null,
      fillPercent: 0,
      allRead: false,
    };
  }

  const viewBottom = scroll.scrollTop + scroll.clientHeight;
  // Content that cannot scroll has been shown in full, so it counts as read.
  const unscrollable =
    scroll.clientHeight > 0 && scroll.scrollHeight <= scroll.clientHeight + TOLERANCE;

  const read = new Set(alreadyRead);
  for (const s of sections) {
    if (unscrollable || viewBottom >= s.top + s.height - TOLERANCE) read.add(s.id);
  }

  let currentId: string | null = null;
  let fractionOfCurrent = 0;
  for (const s of sections) {
    if (read.has(s.id)) continue;
    currentId = s.id;
    fractionOfCurrent = Math.min(1, Math.max(0, (viewBottom - s.top) / Math.max(1, s.height)));
    break;
  }

  const readIds = sections.filter((s) => read.has(s.id)).map((s) => s.id);
  // The fill line spans the gaps between dots, so a document's progress shows
  // once the reader moves to the next one. With exactly two documents that
  // model would show 100% as soon as the first is read, so the two-document
  // case divides by the document count instead.
  const segments = sections.length === 2 ? sections.length : Math.max(1, sections.length - 1);
  const fillPercent = Math.min(100, ((readIds.length + fractionOfCurrent) / segments) * 100);

  return { readIds, currentId, fillPercent, allRead: readIds.length === sections.length };
}

/**
 * Bootstrap progress, before the first measurement has run.
 *
 * Not `computeReadProgress({...}, [], [])`: an empty `sections` list reports
 * `allRead: true`, but here it means "not measured yet", which must keep the
 * checkbox disabled.
 *
 * @param docs - Documents the gate is about to render, in order.
 * @returns Nothing-read progress, or all-read for an empty `docs` list.
 */
export function initialProgress(docs: readonly ConsentDoc[]): ReadProgress {
  return {
    readIds: [],
    currentId: docs[0]?.id ?? null,
    fillPercent: 0,
    allRead: docs.length === 0,
  };
}

/**
 * Tracks read progress for a scroll container holding `docs` in order.
 *
 * Re-measures on scroll and resize, since font loads, Markdown rendering, and
 * orientation changes move the layout after first paint.
 *
 * @param scrollRef - Ref to the scrolling element.
 * @param docs - Documents rendered inside it, in order.
 * @returns Current progress.
 */
export function useReadProgress(
  scrollRef: RefObject<HTMLElement | null>,
  docs: ConsentDoc[],
): ReadProgress {
  const readRef = useRef<string[]>([]);
  const [progress, setProgress] = useState<ReadProgress>(() => initialProgress(docs));

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Section top in the scroller's content space, from a getBoundingClientRect
    // delta. `offsetTop` is relative to the nearest positioned ancestor, which
    // may not be the scroller.
    const readerRect = el.getBoundingClientRect();
    const sections: SectionBox[] = [];
    for (const doc of docs) {
      const node = el.querySelector<HTMLElement>(`[data-consent-section="${doc.id}"]`);
      if (node) {
        const nodeRect = node.getBoundingClientRect();
        sections.push({
          id: doc.id,
          top: nodeRect.top - readerRect.top + el.scrollTop,
          height: nodeRect.height,
        });
      }
    }
    const next = computeReadProgress(
      { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight },
      sections,
      readRef.current,
    );
    // Union with the previous ids so a briefly missing section never makes
    // the tracker go backwards.
    readRef.current = Array.from(new Set([...readRef.current, ...next.readIds]));
    setProgress(next);
  }, [scrollRef, docs]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => {
      el.removeEventListener('scroll', measure);
      ro.disconnect();
    };
  }, [scrollRef, measure]);

  return progress;
}
