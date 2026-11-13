'use client';
/**
 * Read-only public legal page at `/legal`.
 *
 * Shows each audience's Privacy Policy and Terms of Service in one scroll,
 * with a contents rail beside the reading column. `/privacy` and `/terms`
 * redirect to `/legal#privacy` and `/legal#terms`.
 *
 * Every rail entry is a same-page anchor. The rail is grouped by audience,
 * then document, then section, and the reading column follows the same order.
 *
 * This page captures no consent; that is done by `ConsentGate`.
 *
 * @module apps/web/src/components/legal/LegalDocumentView
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import { cn } from '../../lib/cn';
import { MarkdownContent } from '../forms/MarkdownContent';
import { extractSections, type LegalSection } from './legal-sections';
import type { ConsentDocContent } from '../consent/consent-types';
import { BlueDotsLogo } from '../ui/BlueDotsLogo';
import { useThemeMode } from '../../lib/theme-mode';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../hooks/useAggregatorConfig';
import { LanguageSwitcher } from '../shell/LanguageSwitcher';
import { I } from '../../icons';

export type LegalDoc = 'privacy' | 'terms';

/** One audience's rail group and its Terms/Privacy content. */
export interface LegalGroup {
  /** Stable audience key, e.g. `aggregator` or `org`. */
  audience: string;
  /** Localized group label. */
  label: string;
  /** This audience's versioned Terms + Privacy Policy content. */
  content: ConsentDocContent;
}

const DOC_ORDER: LegalDoc[] = ['privacy', 'terms'];

type DocEntry = ConsentDocContent['terms'];

/** One rendered section: its rail metadata plus the markdown body that follows it. */
interface RenderableSection extends LegalSection {
  body: string;
}

/**
 * Builds the anchor id for one audience's document heading.
 *
 * The first group's documents use the bare `privacy` / `terms` ids instead
 * (see `assignPageAnchorIds`).
 *
 * @param audience - The audience key.
 * @param doc - The document key.
 * @returns The anchor id.
 */
function docHeadingId(audience: string, doc: LegalDoc): string {
  return `${audience}-${doc}`;
}

/**
 * Normalizes heading text for a case- and whitespace-insensitive comparison.
 */
function normalizeHeadingText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * True when `heading` is the document's own title, repeated as a heading.
 *
 * Consent documents open with a `##` heading that repeats their title. That
 * heading is dropped so it is not shown twice. Other first headings are kept.
 */
function isDocumentTitleHeading(heading: string, title: string): boolean {
  return normalizeHeadingText(heading) === normalizeHeadingText(title);
}

/**
 * Splits a document's markdown into `##`/`###` sections with anchor ids.
 *
 * A leading title heading is dropped and its prose moves to the preamble.
 * With no headings, the whole body is the preamble. Deeper headings stay as
 * normal content.
 *
 * @param markdown - The document body.
 * @param title - The document's title.
 * @returns Any content before the first real section, plus the sections in order.
 */
function splitIntoSections(
  markdown: string,
  title: string,
): { preamble: string; sections: RenderableSection[] } {
  const ids = extractSections(markdown);
  const lines = markdown.split('\n');
  let inFence = false;
  const preambleLines: string[] = [];
  const bodies: string[][] = [];
  let current: string[] | null = null;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      (current ?? preambleLines).push(line);
      continue;
    }
    // Must match the heading test in `extractSections`, or bodies and
    // sections will not line up.
    if (!inFence && /^#{2,3}\s/.test(line.trim())) {
      current = [];
      bodies.push(current);
      continue;
    }
    (current ?? preambleLines).push(line);
  }

  let sections: RenderableSection[] = ids.map((section, i) => ({
    ...section,
    body: (bodies[i] ?? []).join('\n').trim(),
  }));
  let preamble = preambleLines.join('\n').trim();

  const [leading] = sections;
  if (leading && isDocumentTitleHeading(leading.heading, title)) {
    preamble = [preamble, leading.body].filter(Boolean).join('\n\n');
    sections = sections.slice(1);
  }

  return { preamble, sections };
}

/**
 * Assigns anchor ids that are unique across the whole page.
 *
 * Document heading ids are reserved first, so a section id that collides
 * with one gets a numeric suffix. Ids are assigned in render order.
 *
 * @param groups - Audience groups in render order.
 * @param splitByDoc - Each group's preamble and sections for each document.
 * @returns Document heading ids per group, and sections with page-unique ids.
 */
function assignPageAnchorIds(
  groups: LegalGroup[],
  splitByDoc: Record<LegalDoc, { preamble: string; sections: RenderableSection[] }[]>,
): {
  docIds: Record<string, Record<LegalDoc, string>>;
  sectionsByDoc: Record<LegalDoc, RenderableSection[][]>;
} {
  const seen = new Map<string, number>();
  function reserve(id: string): string {
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    return count === 1 ? id : `${id}-${count}`;
  }

  const docIds: Record<string, Record<LegalDoc, string>> = {};
  groups.forEach((group, gi) => {
    const perDoc = {} as Record<LegalDoc, string>;
    for (const d of DOC_ORDER) {
      // The first group uses bare `privacy` / `terms`, the targets of the
      // `/privacy` and `/terms` redirects.
      perDoc[d] = reserve(gi === 0 ? d : docHeadingId(group.audience, d));
    }
    docIds[group.audience] = perDoc;
  });

  const sectionsByDoc = Object.fromEntries(
    DOC_ORDER.map((d) => [d, [] as RenderableSection[][]]),
  ) as Record<LegalDoc, RenderableSection[][]>;
  groups.forEach((group, gi) => {
    for (const d of DOC_ORDER) {
      sectionsByDoc[d][gi] = splitByDoc[d][gi]!.sections.map((section) => ({
        ...section,
        id: reserve(section.id),
      }));
    }
  });

  return { docIds, sectionsByDoc };
}

/**
 * Returns whether the user prefers reduced motion. Checked on each call, not cached.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  );
}

/**
 * Scrolls an element into view. Does nothing where `scrollIntoView` is missing (jsdom).
 */
function scrollElementIntoView(el: HTMLElement): void {
  el.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
}

/** Rail entry for one document's sections within an audience group. */
function RailSections({
  sections,
  activeSectionId,
  onNavigate,
}: Readonly<{
  sections: LegalSection[];
  activeSectionId: string | null;
  onNavigate: (id: string) => void;
}>) {
  if (sections.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {sections.map((section) => {
        const isActive = activeSectionId === section.id;
        return (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              aria-current={isActive ? 'true' : undefined}
              onClick={(event) => {
                event.preventDefault();
                onNavigate(section.id);
              }}
              className={cn(
                'block rounded-md border-l-2 py-1 pl-3 text-[12.5px] transition-colors',
                isActive
                  ? 'border-(--bd-primary-600) bg-(--bd-primary-50) font-semibold text-(--bd-primary-600)'
                  : 'border-transparent text-ink-500 hover:bg-(--bd-border-soft) hover:text-ink-900',
              )}
            >
              {section.heading}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Renders one document in the rail: its title link and its section list.
 *
 * Document rows carry no "current" marker; only the section highlight from
 * the scroll-spy shows position. `sections` already have page-unique ids.
 */
function RailDocument({
  entry,
  headingId,
  sections,
  activeSectionId,
  onNavigate,
}: Readonly<{
  entry: DocEntry;
  headingId: string;
  sections: LegalSection[];
  activeSectionId: string | null;
  onNavigate: (id: string) => void;
}>) {
  return (
    <div className="mb-3">
      <a
        href={`#${headingId}`}
        onClick={(event) => {
          event.preventDefault();
          onNavigate(headingId);
        }}
        className="block rounded-md py-1 text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink-500 transition-colors hover:bg-(--bd-border-soft) hover:text-(--bd-primary-600)"
      >
        {entry.title}
      </a>
      <RailSections sections={sections} activeSectionId={activeSectionId} onNavigate={onNavigate} />
    </div>
  );
}

/**
 * Formats the localized "Version N · Effective DATE" line for a document.
 *
 * Shows "Version N" only when there is no `effective_from`.
 */
function formatVersionLabel(
  entry: DocEntry,
  t: ReturnType<typeof useTranslations>,
  locale: string,
): string {
  if (!entry.effective_from) return t('version_only', { version: entry.version });
  const date = new Date(entry.effective_from);
  const formatted = Number.isNaN(date.getTime())
    ? entry.effective_from
    : new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(date);
  return t('version_effective', { version: entry.version, date: formatted });
}

/**
 * Renders the `/legal` page: app bar, contents rail, and all documents.
 *
 * The URL fragment decides where the reader lands.
 *
 * @param props.groups - One entry per audience whose content loaded.
 * @returns The legal page, or an "unavailable" message when `groups` is empty.
 */
export function LegalDocumentView({
  groups,
}: Readonly<{
  groups: LegalGroup[];
}>): JSX.Element {
  const t = useTranslations('legal');
  const themeT = useTranslations('theme');
  const locale = useLocale();
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  const { mode, toggle: toggleTheme } = useThemeMode();
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);

  // Split once; the rail and the reading column share the result so their ids match.
  const splitByDoc = useMemo(
    () =>
      Object.fromEntries(
        DOC_ORDER.map((d) => [
          d,
          groups.map((group) =>
            splitIntoSections(group.content[d].content, group.content[d].title),
          ),
        ]),
      ) as Record<LegalDoc, { preamble: string; sections: RenderableSection[] }[]>,
    [groups],
  );

  const { docIds, sectionsByDoc } = useMemo(
    () => assignPageAnchorIds(groups, splitByDoc),
    [groups, splitByDoc],
  );

  // All heading ids the scroll-spy tracks, in render order: each document
  // heading followed by its section ids.
  const allSpyIds = useMemo(
    () =>
      groups.flatMap((group, gi) =>
        DOC_ORDER.flatMap((d) => [
          docIds[group.audience]![d]!,
          ...sectionsByDoc[d][gi]!.map((s) => s.id),
        ]),
      ),
    [groups, sectionsByDoc, docIds],
  );

  // Rail entry to highlight for a document none of whose sections has been
  // reached: its first section, else its heading id.
  const pillFallbackId = useCallback(
    (gi: number, d: LegalDoc): string | undefined => {
      const group = groups[gi];
      if (!group) return undefined;
      return sectionsByDoc[d][gi]?.[0]?.id ?? docIds[group.audience]?.[d];
    },
    [groups, sectionsByDoc, docIds],
  );

  // A heading counts as "passed" once its top is within this distance of the
  // viewport top (the 80px `scroll-mt-20` offset plus slack).
  const READING_LINE_PX = 96;

  // Quiet time after the last scroll event before a click scroll counts as done.
  const SCROLL_SETTLE_MS = 150;

  // Current highlight, readable inside `computeActiveId` without a dependency.
  const activeIdRef = useRef(activeSectionId);
  activeIdRef.current = activeSectionId;

  // Scroll-spy: highlights the last heading whose top is at or above the
  // reading line. Uses heading positions, so short sections work correctly.
  const computeActiveId = useCallback((): string | null => {
    const elements = allSpyIds
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return activeIdRef.current;

    // Last heading, in document order, at or above the reading line.
    let lastPassed: HTMLElement | null = null;
    for (const el of elements) {
      if (el.getBoundingClientRect().top <= READING_LINE_PX) {
        lastPassed = el;
      } else {
        break;
      }
    }

    // At the top of the page: highlight the first document's first section.
    if (!lastPassed) return pillFallbackId(0, DOC_ORDER[0]!) ?? null;

    for (let gi = 0; gi < groups.length; gi += 1) {
      const group = groups[gi]!;
      for (const d of DOC_ORDER) {
        if (docIds[group.audience]?.[d] === lastPassed.id) {
          // A document heading: highlight its first section instead.
          return pillFallbackId(gi, d) ?? lastPassed.id;
        }
      }
    }
    // A section heading: highlight it.
    return lastPassed.id;
  }, [allSpyIds, groups, docIds, pillFallbackId]);

  // During a click or arrival scroll the highlight is pinned to the target,
  // so it does not move through the sections the scroll passes.
  const pinnedIdRef = useRef<string | null>(null);
  const pinReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armPinRelease = useCallback(() => {
    if (pinReleaseTimerRef.current) clearTimeout(pinReleaseTimerRef.current);
    pinReleaseTimerRef.current = setTimeout(() => {
      pinnedIdRef.current = null;
      setActiveSectionId(computeActiveId());
    }, SCROLL_SETTLE_MS);
  }, [computeActiveId]);

  /**
   * Scrolls to `targetElId` and pins the highlight to `pillId` during the scroll.
   *
   * The two differ when the target is a document heading: the pill goes to its first section.
   */
  const scrollAndPin = useCallback(
    (targetElId: string, pillId: string) => {
      setActiveSectionId(pillId);
      pinnedIdRef.current = pillId;
      armPinRelease();
      const el = document.getElementById(targetElId);
      if (el) scrollElementIntoView(el);
    },
    [armPinRelease],
  );

  function navigateTo(id: string) {
    scrollAndPin(id, id);
  }

  // Arrival: scroll to the URL fragment if any. Also listens for `hashchange`
  // so in-page links to `/legal#...` scroll too. With no fragment, highlight
  // the first document's first section.
  useEffect(() => {
    if (groups.length === 0) return;

    function landOnHash() {
      const hashId =
        typeof window !== 'undefined' && window.location.hash
          ? decodeURIComponent(window.location.hash.slice(1))
          : null;

      if (hashId) {
        if (!document.getElementById(hashId)) return;
        // A document fragment scrolls to the document but highlights its first section.
        let pillId = hashId;
        groups.forEach((group, gi) => {
          for (const d of DOC_ORDER) {
            if (docIds[group.audience]?.[d] === hashId) {
              pillId = pillFallbackId(gi, d) ?? hashId;
            }
          }
        });
        scrollAndPin(hashId, pillId);
        return;
      }

      // Already at the top; no scroll or pin needed.
      const fallbackPillId = pillFallbackId(0, DOC_ORDER[0]!);
      if (fallbackPillId) setActiveSectionId(fallbackPillId);
    }

    landOnHash();
    window.addEventListener('hashchange', landOnHash);
    return () => window.removeEventListener('hashchange', landOnHash);
    // Keyed on `groups.length`, not on every id recomputation.
  }, [groups.length, groups, docIds, pillFallbackId, scrollAndPin]);

  // Recomputes the highlight on scroll and resize, unless it is pinned.
  useEffect(() => {
    if (allSpyIds.length === 0) return;

    function handleScroll() {
      if (pinnedIdRef.current) {
        // Still scrolling: push the pin release back.
        armPinRelease();
        return;
      }
      setActiveSectionId(computeActiveId());
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleScroll);
    return () => {
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
    };
  }, [allSpyIds, computeActiveId, armPinRelease]);

  // Clear the pin timer on unmount.
  useEffect(() => {
    return () => {
      if (pinReleaseTimerRef.current) clearTimeout(pinReleaseTimerRef.current);
    };
  }, []);

  if (groups.length === 0) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-(--bd-bg) px-6 py-12">
        {/* `<output>` has the implicit `status` role. */}
        <output className="text-sm text-ink-500">{t('unavailable')}</output>
      </div>
    );
  }

  return (
    <div className="min-h-svh bg-(--bd-bg)">
      {/* App bar: brand logo, back link to sign-in, and language and theme
          controls. It spans the full width and sticks to the top. Its fixed
          `h-14` matches the rail's `md:top-14`. No `useAuth` here: the page
          is public. */}
      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-(--bd-border) bg-(--bd-card) px-4 sm:px-6">
        {cfg.brand.logo?.default ? (
          <Image
            src={cfg.brand.logo.default}
            alt={cfg.brand.short_name}
            width={160}
            height={40}
            priority
            className="h-9 w-auto shrink-0 object-contain object-left"
          />
        ) : (
          <div className="flex min-w-0 shrink-0 items-center gap-2.5">
            <BlueDotsLogo size={36} />
            <span className="truncate font-display text-[15px] font-bold leading-tight text-ink-900">
              {cfg.brand.short_name}
            </span>
          </div>
        )}

        <Link
          href="/login"
          aria-label={t('back_to_sign_in')}
          className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-ink-500 transition-colors hover:text-(--bd-primary-600)"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">{t('back_to_sign_in')}</span>
        </Link>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <LanguageSwitcher />
          <button
            type="button"
            onClick={toggleTheme}
            title={mode === 'dark' ? themeT('switch_to_light') : themeT('switch_to_dark')}
            aria-label={themeT('toggle_aria')}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-(--bd-border) bg-(--bd-card) text-(--bd-fg-muted) transition-colors hover:bg-(--bd-border-soft) hover:text-(--bd-fg)"
          >
            {mode === 'dark' ? <I.sun size={16} /> : <I.moon size={16} />}
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="grid gap-8 md:grid-cols-[240px_1fr] md:gap-10">
          <nav
            aria-label={t('contents_label')}
            // Sticks just under the app bar. Scrolls on its own because it is
            // taller than the viewport; `overscroll-contain` keeps that scroll
            // from moving the page.
            className="md:sticky md:top-14 md:max-h-[calc(100svh-3.5rem)] md:self-start md:overflow-y-auto md:overscroll-contain md:border-r md:border-(--bd-border) md:py-6 md:pr-6"
          >
            {groups.map((group, gi) => (
              <div key={group.audience} className="mb-6">
                <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-ink-500">
                  {group.label}
                </p>
                {DOC_ORDER.map((d) => (
                  <RailDocument
                    key={d}
                    entry={group.content[d]}
                    headingId={docIds[group.audience]![d]!}
                    sections={sectionsByDoc[d][gi]!}
                    activeSectionId={activeSectionId}
                    onNavigate={navigateTo}
                  />
                ))}
              </div>
            ))}
          </nav>

          <div className="min-w-0 max-w-[72ch]">
            {groups.map((group, gi) => {
              const audienceHeadingId = `${group.audience}-audience`;
              return (
                <section
                  key={group.audience}
                  aria-labelledby={audienceHeadingId}
                  className="mt-10 border-t border-(--bd-border) pt-8 first:mt-6 first:border-t-0 first:pt-0"
                >
                  {/* Audience heading marks where each audience starts. */}
                  <h2
                    id={audienceHeadingId}
                    className="mb-6 scroll-mt-20 text-2xl font-bold text-ink-900"
                  >
                    {group.label}
                  </h2>

                  {DOC_ORDER.map((d) => {
                    const entry = group.content[d];
                    const { preamble } = splitByDoc[d][gi]!;
                    const sections = sectionsByDoc[d][gi]!;
                    const isFirstDoc = d === DOC_ORDER[0];
                    return (
                      // A divider and space before every document but the first.
                      <div
                        key={d}
                        className={cn(
                          'scroll-mt-20',
                          !isFirstDoc && 'mt-10 border-t border-(--bd-border) pt-8',
                        )}
                      >
                        {/* Document title from the `title` field. The
                            markdown's own title heading is stripped. */}
                        <h3
                          id={docIds[group.audience]![d]}
                          className="mt-2 mb-1 scroll-mt-20 text-xl font-bold text-ink-900"
                        >
                          {entry.title}
                        </h3>
                        <p className="mb-4 text-xs text-ink-500">
                          {formatVersionLabel(entry, t, locale)}
                        </p>

                        {preamble && <MarkdownContent content={preamble} />}

                        {sections.map((section) =>
                          section.level === 2 ? (
                            <div key={section.id}>
                              <h2
                                id={section.id}
                                className="mt-8 mb-2 scroll-mt-20 text-lg font-bold text-ink-900"
                              >
                                {section.heading}
                              </h2>
                              {section.body && <MarkdownContent content={section.body} />}
                            </div>
                          ) : (
                            <div key={section.id}>
                              <h3
                                id={section.id}
                                className="mt-6 mb-2 scroll-mt-20 text-base font-semibold text-ink-900"
                              >
                                {section.heading}
                              </h3>
                              {section.body && <MarkdownContent content={section.body} />}
                            </div>
                          ),
                        )}
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
