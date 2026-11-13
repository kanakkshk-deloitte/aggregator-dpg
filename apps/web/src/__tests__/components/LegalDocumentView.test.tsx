import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, act } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import type * as UseAggregatorConfigModule from '@/hooks/useAggregatorConfig';
import messages from '@/i18n/messages/en.json';
import { LegalDocumentView, type LegalGroup } from '@/components/legal/LegalDocumentView';
import { EnabledLocalesProvider } from '@/i18n/EnabledLocalesProvider';

// The app bar (item 2 of the consent-scroll-gate port) reads the brand logo
// and theme mode. Neither is under test here, so both are stubbed to their
// real defaults (`useAggregatorConfig` re-exports the actual
// `DEFAULT_AGGREGATOR_CONFIG`, which carries no brand logo, so the page
// falls back to `BlueDotsLogo`) rather than requiring a real
// `QueryClientProvider` in every test's render tree.
vi.mock('@/hooks/useAggregatorConfig', async () => {
  const actual = await vi.importActual<typeof UseAggregatorConfigModule>(
    '@/hooks/useAggregatorConfig',
  );
  return {
    ...actual,
    useAggregatorConfig: () => ({ data: undefined, isError: false }),
  };
});
vi.mock('@/lib/theme-mode', () => ({
  useThemeMode: () => ({ mode: 'light', setMode: vi.fn(), toggle: vi.fn() }),
}));

// Mirrors the root layout's providers. `EnabledLocalesProvider` is needed for
// the embedded LanguageSwitcher to render at all — without it the switcher
// falls back to English only and hides itself.
function Wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <EnabledLocalesProvider value={['en', 'kn', 'hi']}>{children}</EnabledLocalesProvider>
    </NextIntlClientProvider>
  );
}

/**
 * Renders the page as if arrived at `/legal${hash}`. There is one route now, so
 * what used to be "which document is this route for" is the fragment — set on
 * `window.location` before mount, the way a real arrival presents it.
 */
function renderView(hash: string, groups: LegalGroup[]) {
  window.location.hash = hash;
  return render(
    <Wrapper>
      <LegalDocumentView groups={groups} />
    </Wrapper>,
  );
}

// Illustrative fixture used by most tests below — general rendering behaviour
// (rail groups, anchors, version display, no-checkbox, empty state) that does
// not turn on the leading-title-heading trap.
//
// The audience keys here are arbitrary: this component renders whatever groups
// it is handed and knows nothing about which audiences exist. `participant` is
// deliberately kept as the first group even though production no longer
// publishes one (see `load-legal-groups.server`) — nothing in these tests
// should depend on the real audience list.
const groups: LegalGroup[] = [
  {
    audience: 'participant',
    label: 'For participants',
    content: {
      privacy: { version: 1, title: 'Privacy Policy', content: '## Overview\n### Retention\nx' },
      terms: { version: 1, title: 'Terms of Service', content: '## Overview' },
    },
  },
  {
    audience: 'aggregator',
    label: 'For aggregators',
    content: {
      privacy: { version: 2, title: 'Privacy Policy', content: '## Overview' },
      terms: { version: 2, title: 'Terms of Service', content: '## Overview' },
    },
  },
];

describe('<LegalDocumentView />', () => {
  it('renders a rail group per audience', () => {
    renderView('', groups);
    // Each audience's label now renders twice — once in the rail, once as
    // the reading column's audience-boundary heading (see the "audience
    // boundary is legible" fix) — so this scopes to the rail specifically.
    const nav = screen.getByRole('navigation', { name: 'Contents' });
    expect(within(nav).getByText('For participants')).toBeInTheDocument();
    expect(within(nav).getByText('For aggregators')).toBeInTheDocument();
  });

  it('links each extracted section as a same-page anchor', () => {
    renderView('', groups);
    expect(screen.getByRole('link', { name: 'Retention' })).toHaveAttribute('href', '#retention');
  });

  // Both of an audience's documents now render together, so each version
  // number appears once per document — twice per audience in this fixture,
  // since both of participant's documents (and both of aggregator's) share a
  // version number.
  it('shows the version for each audience and each document', () => {
    renderView('', groups);
    expect(screen.getAllByText(/Version 1/)).toHaveLength(2);
    expect(screen.getAllByText(/Version 2/)).toHaveLength(2);
  });

  // Regression for the reported defect: scrolling from one document's
  // content into the next used to give no indication a new document had
  // started (the title appeared once, at the very top of the page, and
  // never again). Every document — for every audience — now carries its own
  // title heading right where its content begins, sourced from the `title`
  // field.
  it("renders each document's own title where its content begins, for every document", () => {
    renderView('', groups);
    expect(screen.getAllByRole('heading', { name: 'Privacy Policy' })).toHaveLength(2);
    expect(screen.getAllByRole('heading', { name: 'Terms of Service' })).toHaveLength(2);
  });

  // Regression for the sibling defect: nothing in the reading column marked
  // where one audience's documents ended and the next audience's began.
  it('makes the audience boundary legible in the reading column', () => {
    renderView('', groups);
    expect(screen.getByRole('heading', { name: 'For participants' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'For aggregators' })).toBeInTheDocument();
  });

  it('captures no consent — there is no checkbox anywhere on the page', () => {
    renderView('#terms', groups);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('renders a helpful empty state when no consent content loaded', () => {
    renderView('', []);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  // Regression for the reported defect: every audience's "Privacy Policy"
  // rail heading used to light up blue on `/privacy`, because "current" was
  // derived from the route (which document *kind*) rather than from where
  // the reader actually is. All six documents live on one page now, so
  // every "Privacy Policy" heading matches the route equally — the fix is
  // that the route must not drive any document-level styling at all.
  it('does not tint every same-named document heading — the route no longer drives document styling', () => {
    renderView('', groups);
    const privacyLinks = screen.getAllByRole('link', { name: 'Privacy Policy' });
    expect(privacyLinks).toHaveLength(2);
    // Identical classes — no "current document" tint on either.
    expect(privacyLinks[0]!.className).toBe(privacyLinks[1]!.className);
  });

  // Regression for the surviving half of the same defect: once the visual
  // tint was removed, `aria-current="page"` stayed behind on every
  // document-heading anchor, still route-derived — so a screen reader
  // announced all of a route's same-named document headings as "current"
  // (verified: three "current page" hits on `/terms`, none on `/privacy`).
  // "Which document is current" isn't a fact the route knows on a page that
  // renders every document at once, so the attribute is dropped from the
  // document heading entirely — the section pill is the one live indicator.
  it('never puts aria-current on a document-heading anchor, on either route', () => {
    renderView('', groups);
    for (const link of screen.getAllByRole('link', { name: /Privacy Policy|Terms of Service/ })) {
      expect(link).not.toHaveAttribute('aria-current');
    }
  });

  // Regression for the sibling defect: the non-routed document ("Terms of
  // Service" on `/privacy`) used to render its whole rail row — heading and
  // sections alike — at reduced opacity, reading as disabled even though
  // every entry is perfectly clickable. Every document row must look the
  // same regardless of which document (or route) is "current".
  it('does not dim the other document — every document row looks the same', () => {
    renderView('', groups);
    const privacyLink = screen.getAllByRole('link', { name: 'Privacy Policy' })[0]!;
    const termsLink = screen.getAllByRole('link', { name: 'Terms of Service' })[0]!;
    expect(privacyLink.className).toBe(termsLink.className);
    expect(privacyLink.closest('div')?.className).not.toMatch(/opacity/);
    expect(termsLink.closest('div')?.className).not.toMatch(/opacity/);
  });

  // /privacy and /terms must render an identical-looking rail — the route
  // only decides which document the reader lands on (which, in turn,
  // legitimately moves the scroll-spy's single pill), never how a document
  // heading is styled. Compares the document-level rail entries' classes
  // specifically, not the section pill, which is expected to differ between
  // the two routes' different arrival positions.
  it('styles every document row identically on /privacy and /terms', () => {
    const { unmount } = renderView('', groups);
    const privacyClasses = screen
      .getAllByRole('link', { name: /Privacy Policy|Terms of Service/ })
      .map((link) => link.className)
      .sort();
    unmount();

    renderView('#terms', groups);
    const termsClasses = screen
      .getAllByRole('link', { name: /Privacy Policy|Terms of Service/ })
      .map((link) => link.className)
      .sort();

    expect(termsClasses).toEqual(privacyClasses);
  });

  // Regression for an older defect: this rail entry used to be a route
  // `Link` (`href="/terms"`), so hovering it showed a full navigation
  // instead of an in-page anchor. Both documents already render on this
  // page, so it must be a same-page anchor. Neither carries aria-current —
  // document-heading anchors never do, regardless of scroll position (see
  // the dedicated test above).
  it('links to the other document as a same-page anchor, not a route', () => {
    renderView('', groups);
    const otherLinks = screen.getAllByRole('link', { name: 'Terms of Service' });
    expect(otherLinks).toHaveLength(2);
    // The FIRST group's documents own the bare `#terms` fragment — that is
    // what `/terms` redirects to. Later groups keep their audience-scoped ids.
    expect(otherLinks.map((l) => l.getAttribute('href')).sort()).toEqual([
      '#aggregator-terms',
      '#terms',
    ]);
    for (const link of otherLinks) {
      expect(link).not.toHaveAttribute('aria-current');
    }
  });

  it('uses the i18n contents label for the rail, not a hardcoded string', () => {
    renderView('', groups);
    expect(screen.getByRole('navigation', { name: 'Contents' })).toBeInTheDocument();
  });

  it('has a back-to-sign-in link', () => {
    renderView('', groups);
    expect(screen.getByRole('link', { name: /Back to sign in/i })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('clicking a rail section scrolls it into view and highlights it', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    renderView('', groups);

    const link = screen.getByRole('link', { name: 'Retention' });
    fireEvent.click(link);

    expect(scrollIntoView).toHaveBeenCalled();
    expect(link).toHaveAttribute('aria-current', 'true');
  });

  it("clicking the other document's rail header scrolls to its heading", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    renderView('', groups);

    const [termsHeader] = screen.getAllByRole('link', { name: 'Terms of Service' });
    fireEvent.click(termsHeader!);

    expect(scrollIntoView).toHaveBeenCalled();
  });

  // --- Trap 1 regression: every real consent document opens with a `##`
  // heading that repeats its own `title` verbatim. Fixture built with the
  // real shape (leading `## Privacy Policy`), per the corrected brief — a
  // fixture that opens with `## Overview` (the sibling's original mistake)
  // would never exercise this bug. ---
  const realShapeGroups: LegalGroup[] = [
    {
      audience: 'participant',
      label: 'For participants',
      content: {
        privacy: {
          version: 1,
          title: 'Privacy Policy',
          content: '## Privacy Policy\n\nIntro paragraph.\n### Retention\nx',
          effective_from: '2026-07-01',
        },
        terms: {
          version: 1,
          title: 'Terms of Service',
          content: '## Terms of Service\n\nWelcome.',
          effective_from: '2026-07-01',
        },
      },
    },
  ];

  it('does not repeat the document title as a second heading or as the rail’s first section', () => {
    renderView('', realShapeGroups);
    // Exactly one heading reads "Privacy Policy" — the page's own <h1>, not a
    // duplicated <h2> for the leading `## Privacy Policy` in the markdown.
    expect(screen.getAllByRole('heading', { name: 'Privacy Policy' })).toHaveLength(1);
    // The rail's first (and only real) section entry is "Retention" — the
    // leading title heading must not appear as a rail entry of its own.
    expect(screen.getAllByRole('link', { name: 'Retention' })).toHaveLength(1);
  });

  it('keeps a section that legitimately opens with a non-title heading like Overview', () => {
    const overviewGroups: LegalGroup[] = [
      {
        audience: 'participant',
        label: 'For participants',
        content: {
          privacy: {
            version: 1,
            title: 'Privacy Policy',
            content: '## Overview\n\nSomething else entirely.',
          },
          terms: {
            version: 1,
            title: 'Terms of Service',
            content: '## Terms of Service\n\nWelcome.',
          },
        },
      },
    ];
    renderView('', overviewGroups);
    expect(screen.getByRole('heading', { name: 'Overview' })).toHaveAttribute('id', 'overview');
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('href', '#overview');
  });

  it('renders the heading it links to, so the anchor actually lands', () => {
    renderView('', realShapeGroups);
    const heading = screen.getByRole('heading', { name: 'Retention' });
    expect(heading).toHaveAttribute('id', 'retention');
  });

  it('renders a document with no ### headings at all, without crashing', () => {
    const noSubsectionGroups: LegalGroup[] = [
      {
        audience: 'participant',
        label: 'For participants',
        content: {
          privacy: {
            version: 1,
            title: 'Privacy Policy',
            content: '## Privacy Policy\n\nJust a paragraph, no subsections at all.',
          },
          terms: {
            version: 1,
            title: 'Terms of Service',
            content: '## Terms of Service\n\nWelcome.',
          },
        },
      },
    ];
    renderView('', noSubsectionGroups);
    expect(screen.getByText('Just a paragraph, no subsections at all.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
  });

  it('renders a document with five levels of heading nesting, without crashing', () => {
    const deepNestingGroups: LegalGroup[] = [
      {
        audience: 'participant',
        label: 'For participants',
        content: {
          privacy: {
            version: 1,
            title: 'Privacy Policy',
            content:
              '## Privacy Policy\n\n### A section\nintro\n#### A subsection\nmore\n##### Deeper still\neven more\n###### Deepest\ndeepest text',
          },
          terms: {
            version: 1,
            title: 'Terms of Service',
            content: '## Terms of Service\n\nWelcome.',
          },
        },
      },
    ];
    renderView('', deepNestingGroups);
    expect(screen.getByRole('heading', { name: 'A section' })).toBeInTheDocument();
    expect(screen.getByText('deepest text')).toBeInTheDocument();
  });

  // Three audiences, all carrying a colliding "### Grievances" section under
  // Privacy Policy — the real shape: every real audience's Privacy Policy
  // document has one (verified against the live config).
  const collidingGroups: LegalGroup[] = [
    {
      audience: 'participant',
      label: 'For participants',
      content: {
        privacy: {
          version: 1,
          title: 'Privacy Policy',
          content: '## Privacy Policy\n### Grievances\nparticipant body',
        },
        terms: { version: 1, title: 'Terms of Service', content: '## Terms of Service' },
      },
    },
    {
      audience: 'aggregator',
      label: 'For aggregators',
      content: {
        privacy: {
          version: 1,
          title: 'Privacy Policy',
          content: '## Privacy Policy\n### Grievances\naggregator body',
        },
        terms: { version: 1, title: 'Terms of Service', content: '## Terms of Service' },
      },
    },
    {
      audience: 'org',
      label: 'For organisations',
      content: {
        privacy: {
          version: 1,
          title: 'Privacy Policy',
          content: '## Privacy Policy\n### Grievances\norg body',
        },
        terms: { version: 1, title: 'Terms of Service', content: '## Terms of Service' },
      },
    },
  ];

  it('gives colliding section ids across audiences a unique suffix so anchors do not clash', () => {
    renderView('', collidingGroups);
    const headings = screen.getAllByRole('heading', { name: 'Grievances' });
    const ids = headings.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('grievances');
  });

  // Regression for a half-fix: cross-group dedup was applied to the rendered
  // headings but not threaded into the rail's hrefs, so all three "Grievances"
  // rail links pointed at the same bare "#grievances" — two of three silently
  // jumped to the wrong audience's section instead of their own. This proves
  // *correspondence* (each rail entry's href resolves to exactly one heading,
  // which belongs to that same audience's reading section), not just that the
  // heading ids happen to be unique.
  //
  // Extended for this port to also prove the same correspondence one level up
  // the hierarchy: each audience's own *document*-level rail entry (its
  // "Privacy Policy" / "Terms of Service" row) resolves to that same
  // audience's document block too, now that every audience's every document
  // shares one page and one id namespace.
  it('each audience group’s rail link resolves to that same audience’s heading, not another’s', () => {
    const { container } = renderView('', collidingGroups);
    const nav = screen.getByRole('navigation', { name: 'Contents' });

    for (const [label, audience] of [
      ['For participants', 'participant'],
      ['For aggregators', 'aggregator'],
      ['For organisations', 'org'],
    ] as const) {
      // Scope to this audience's rail group (the <div> wrapping its <p> label
      // and its two RailDocument rows). Scoped to the rail (`nav`), not the
      // whole page — the audience label also renders as the reading
      // column's audience-boundary heading now, so an unscoped
      // `getByText(label)` would match twice.
      const groupContainer = within(nav).getByText(label).closest('div');
      expect(groupContainer).not.toBeNull();

      // --- section-level correspondence ---
      const link = within(groupContainer!).getByRole('link', { name: 'Grievances' });
      const href = link.getAttribute('href');
      expect(href).toMatch(/^#/);
      const targetId = href!.slice(1);

      // Exactly one element carries that id.
      const matches = container.querySelectorAll(`#${CSS.escape(targetId)}`);
      expect(matches).toHaveLength(1);
      const heading = matches[0]!;
      expect(heading.tagName).toBe('H3');
      expect(heading.textContent).toBe('Grievances');

      // And it must live inside *this* audience's reading section, not
      // another audience's — the actual bug: an org rail link landing on the
      // participant heading because both rendered as bare "#grievances".
      const readingSection = screen.getByRole('region', { name: label });
      expect(readingSection.contains(heading)).toBe(true);

      // Sanity: the section's body text is this audience's own copy, not a
      // different audience's — confirms we didn't just get lucky landing on
      // *a* Grievances heading that happens to sit inside the right section.
      expect(readingSection.textContent).toContain(`${audience} body`);

      // --- document-level correspondence ---
      const privacyDocLink = within(groupContainer!).getByRole('link', { name: 'Privacy Policy' });
      const docHref = privacyDocLink.getAttribute('href');
      expect(docHref).toMatch(/^#/);
      const docTargetId = docHref!.slice(1);
      const docMatches = container.querySelectorAll(`#${CSS.escape(docTargetId)}`);
      expect(docMatches).toHaveLength(1);
      expect(readingSection.contains(docMatches[0]!)).toBe(true);
      // Structural, not content-derived. The first group's is the bare
      // document key (the fragment `/privacy` redirects to); the rest carry
      // their audience key.
      expect(docTargetId).toBe(
        audience === groups[0]!.audience ? 'privacy' : `${audience}-privacy`,
      );
    }
  });
});

// jsdom has no layout engine — it computes no scroll heights and honours no
// `position: sticky` — so these assert the utility classes that produce the
// behaviour rather than the behaviour itself. That is a real limit: they prove
// the classes are present, not that the rail scrolls. They exist because every
// defect below shipped once, and each was a single class (or a single element's
// placement) away from correct.
// The two paths operators have already shared over SMS and email (#637) now
// redirect into this page with a fragment, so those fragments have to resolve
// to the first audience's documents — the audience those links are for.
describe('<LegalDocumentView /> fragments the redirects target', () => {
  it("anchors the first audience's documents at the bare #privacy and #terms", () => {
    const { container } = renderView('', groups);
    expect(container.querySelector('#privacy')).not.toBeNull();
    expect(container.querySelector('#terms')).not.toBeNull();
    // Scoped to the first group, not just present somewhere on the page.
    const firstGroup = screen.getByRole('region', { name: 'For participants' });
    expect(firstGroup.contains(container.querySelector('#privacy'))).toBe(true);
    expect(firstGroup.contains(container.querySelector('#terms'))).toBe(true);
  });

  it('keeps a section that slugifies to a document name from stealing its id', () => {
    // A "Privacy" section would otherwise take `#privacy` out from under a
    // link that has already been shared.
    const collidingGroups: LegalGroup[] = [
      {
        audience: 'participant',
        label: 'For participants',
        content: {
          privacy: { version: 1, title: 'Privacy Policy', content: '## Overview\n### Privacy\nx' },
          terms: { version: 1, title: 'Terms of Service', content: '## Overview' },
        },
      },
    ];
    const { container } = renderView('', collidingGroups);

    const docHeading = container.querySelector('#privacy');
    expect(docHeading?.textContent).toBe('Privacy Policy');
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '#privacy-2');
  });
});

describe('<LegalDocumentView /> app bar and rail geometry', () => {
  it('pins the app bar to the top of the viewport, opaquely', () => {
    // It used to be a plain in-flow div that scrolled away, and the reading
    // column showed through anything translucent behind it.
    const { container } = renderView('', groups);
    const bar = container.querySelector('header');
    expect(bar?.className).toContain('sticky');
    expect(bar?.className).toContain('top-0');
    expect(bar?.className).toContain('bg-(--bd-card)');
  });

  it('puts the app bar outside the reading column so it spans the viewport', () => {
    // Nested inside `max-w-5xl` it ended mid-screen, indented from the top
    // corner — the sibling Signals page spans the full width.
    const { container } = renderView('', groups);
    const bar = container.querySelector('header');
    expect(bar?.parentElement?.className).not.toContain('max-w-5xl');
    expect(bar?.closest('.max-w-5xl')).toBeNull();
  });

  it('renders both the language and the theme control in the app bar', () => {
    // The language switcher used to float separately from the route group's
    // layout, clear of the bar entirely.
    const { container } = renderView('', groups);
    const bar = container.querySelector('header');
    expect(within(bar as HTMLElement).getByRole('button', { name: /theme/i })).toBeInTheDocument();
    expect(bar?.querySelector('[aria-label="Language"]')).not.toBeNull();
  });

  it('bounds the rail and lets it scroll on its own', () => {
    // Three audiences x two documents x ~12 sections is taller than any
    // viewport; `md:h-fit` left its tail unreachable.
    renderView('', groups);
    const rail = screen.getByRole('navigation', { name: 'Contents' });
    expect(rail.className).toMatch(/md:max-h-/);
    expect(rail.className).toContain('md:overflow-y-auto');
    expect(rail.className).not.toContain('md:h-fit');
  });

  it('offsets the rail by the app bar height so the bar does not cover it', () => {
    renderView('', groups);
    expect(screen.getByRole('navigation', { name: 'Contents' }).className).toContain('md:top-14');
  });

  it('offsets every anchor target clear of the app bar', () => {
    // Without a scroll-margin at least the bar's height, an anchor lands its
    // heading underneath the bar.
    renderView('', groups);
    for (const name of ['For participants', 'Overview', 'Retention']) {
      expect(screen.getAllByRole('heading', { name })[0]!.className).toContain('scroll-mt-20');
    }
  });

  it('rules off each document after the first, so one does not run into the next', () => {
    // Privacy's last section ran straight into the Terms title with nothing
    // between them.
    renderView('', groups);
    const termsTitle = screen.getAllByRole('heading', { name: 'Terms of Service' })[0]!;
    // The document wrapper, which carries the boundary.
    expect(termsTitle.parentElement?.className).toContain('border-t');
    const privacyTitle = screen.getAllByRole('heading', { name: 'Privacy Policy' })[0]!;
    // ...and the first document in an audience must NOT carry one, or it
    // would double up with the audience boundary just above it.
    expect(privacyTitle.parentElement?.className).not.toContain('border-t');
  });
});

describe('<LegalDocumentView /> arrival landing', () => {
  it('does nothing on /privacy with no hash — privacy is already the top of the page', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    renderView('', groups);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls to the first audience’s terms heading when arriving at /terms with no hash', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    renderView('#terms', groups);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  // Both documents open with intro prose before their first heading, so at
  // scroll-top the scroll-spy has nothing "in view" to highlight on its own
  // — without a fallback, the rail would land with no pill at all. Each
  // route's first section must be pilled on arrival, and it must be that
  // ROUTE's document's first section specifically (not merely whichever
  // section happens to render first on the page, which is always the first
  // audience's Privacy Policy).
  const BOTH_HAVE_SECTIONS: LegalGroup[] = [
    {
      audience: 'participant',
      label: 'For participants',
      content: {
        privacy: {
          version: 1,
          title: 'Privacy Policy',
          content: '## Privacy Policy\n\nIntro.\n### Retention\nx',
        },
        terms: {
          version: 1,
          title: 'Terms of Service',
          content: '## Terms of Service\n\nWelcome.\n### Governing law\nIndia.',
        },
      },
    },
  ];

  it('pills the first section on arrival at /privacy', () => {
    renderView('', BOTH_HAVE_SECTIONS);
    expect(screen.getByRole('link', { name: 'Retention' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: 'Governing law' })).not.toHaveAttribute('aria-current');
  });

  it('pills the first section on arrival at /terms — Terms’ own first section, not Privacy’s', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView =
      scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    renderView('#terms', BOTH_HAVE_SECTIONS);
    expect(screen.getByRole('link', { name: 'Governing law' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Retention' })).not.toHaveAttribute('aria-current');
  });
});

describe('<LegalDocumentView /> click pins the highlight through its scroll', () => {
  // Reproduction: a rail entry whose section body is short enough that the
  // FOLLOWING heading also ends up within the scroll-spy's "passed the
  // reading line" reach while the click's scroll is still in flight.
  // Without a pin, that transient geometry would win and the pill would
  // drift to the next entry down instead of staying on the one just
  // clicked — the real defect found on this repo's org audience's own
  // short "Sharing" section.
  const SHORT_SECTION_GROUPS: LegalGroup[] = [
    {
      audience: 'org',
      label: 'For organisations',
      content: {
        privacy: {
          version: 1,
          title: 'Privacy Policy',
          content:
            '## Privacy Policy\n\nIntro.\n### First\nBody one.\n### Sharing\nx\n### Third\nBody three.',
        },
        terms: {
          version: 1,
          title: 'Terms of Service',
          content: '## Terms of Service\n\nWelcome.',
        },
      },
    },
  ];

  function mockTop(id: string, top: number) {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top,
      bottom: top + 20,
      left: 0,
      right: 0,
      width: 0,
      height: 20,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
  }

  beforeEach(() => {
    Element.prototype.scrollIntoView =
      vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the clicked short "Sharing" section highlighted through a misleading mid-scroll read, and after settling', () => {
    vi.useFakeTimers();
    renderView('', SHORT_SECTION_GROUPS);

    const sharingLink = screen.getByRole('link', { name: 'Sharing' });
    fireEvent.click(sharingLink);
    expect(sharingLink).toHaveAttribute('aria-current', 'true');

    // Mid-flight: geometry momentarily suggests "Third" has also passed the
    // reading line (the short-section overshoot). A spy with no pin would
    // jump to it right here.
    mockTop('privacy', 0);
    mockTop('first', -50);
    mockTop('sharing', 10);
    mockTop('third', 50);
    fireEvent.scroll(window);

    expect(screen.getByRole('link', { name: 'Sharing' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: 'Third' })).not.toHaveAttribute('aria-current');

    // Settled: the transient reading was transient — at rest, only
    // "Sharing" has actually reached the reading line.
    mockTop('third', 150);
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.getByRole('link', { name: 'Sharing' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('link', { name: 'Third' })).not.toHaveAttribute('aria-current');
  });
});
