# Consent Scroll Gate — aggregator-dpg Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every inline consent checkbox in the aggregator web app with a blocking gate that makes the user scroll through all consent documents before they can agree.

**Architecture:** One new `ConsentGate` component renders every consent document in a single continuous scroll with a progress tracker above it. All scroll-gating logic lives in a pure function (`computeReadProgress`) wrapped by a thin hook, so the interesting behaviour is unit-testable without relying on jsdom layout. Four call sites are converted to open the gate instead of rendering their own checkbox. The existing read-only `ConsentModal` is left untouched.

**Tech Stack:** Next.js App Router, React 18, TypeScript, Tailwind v4, next-intl, RJSF, Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-08-20-consent-scroll-gate-design.md`

**Sibling plan:** `docs/superpowers/plans/2026-08-20-consent-scroll-gate-signals.md` (Signals-DPG, developed in parallel — behaviour must stay identical).

## Global Constraints

- Branch `feat/636-consent-scroll-gate`, base `feature`. Never commit to `feature`.
- Conventional Commits. **Commit subjects must start lowercase** — commitlint rejects sentence-case subjects.
- husky/lint-staged runs on every commit. **Never bypass** (`--no-verify`, `core.hooksPath`).
- A fresh worktree must run `pnpm --filter "./packages/*" build` once before the web suite will collect. Already done in this worktree.
- Every i18n key added must be added to **all three** locales: `en.json`, `hi.json`, `kn.json`.
- **No JSON schema file changes.** `consent` stays `required` in all 10 schema files across 6 config trees; the API validates server-side.
- **No API change**, so no `openapi.json` regeneration.
- Logging (if any added) follows `.claude/rules/logging-observability.md`: a structured `{operation, status}` merging object plus a message, never a bare string.
- Scope test runs per-package. The full monorepo suite at parallelism produces intermittent unrelated timeouts on this machine.
- Run one file: `pnpm --filter @aggregator-dpg/web exec vitest run <path>`
- Run the package: `pnpm --filter @aggregator-dpg/web test`

## File Structure

| File                                                                      | Responsibility                                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/web/src/components/consent/consent-docs.ts` (create)                | Turns `ConsentDocContent` / `ParticipantConsent` into the ordered `ConsentDoc[]` the gate reads. Pure. |
| `apps/web/src/components/consent/read-progress.ts` (create)               | `computeReadProgress` (pure) + `useReadProgress` (thin hook). All scroll-gating logic.                 |
| `apps/web/src/components/consent/ConsentProgressTracker.tsx` (create)     | The dots-and-line tracker. Presentational only.                                                        |
| `apps/web/src/components/consent/ConsentGate.tsx` (create)                | Blocking modal: header, tracker, single scroll region, footer with checkbox + CTA.                     |
| `apps/web/src/components/forms/ConsentCheckboxWidget.tsx` (modify)        | Becomes a gate trigger for the two RJSF registration forms.                                            |
| `apps/web/src/app/(public)/register/registration-shared.ts` (modify)      | Adds `stripConsentBlock`.                                                                              |
| `apps/web/src/app/(public)/register/OrgRegisterForm.tsx` (modify)         | Strips consent from the client schema; gate supplies it on submit.                                     |
| `apps/web/src/app/(public)/register/CoordinatorRegisterForm.tsx` (modify) | Same.                                                                                                  |
| `apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx` (modify)       | Three-document gate replaces the inline checkbox.                                                      |
| `apps/web/src/app/[org]/[slug]/MinimalIdentityForm.tsx` (modify)          | Two-document gate replaces the inline checkbox.                                                        |
| `apps/web/src/i18n/messages/{en,hi,kn}.json` (modify)                     | New shared `consent_gate` namespace.                                                                   |

**Design note — why a pure function.** jsdom performs no layout: `offsetTop`, `offsetHeight`, `scrollHeight` and `clientHeight` are all `0`. Testing scroll gating through the DOM therefore requires stubbing layout on every element and is brittle. Instead `computeReadProgress` takes plain numbers, holds 100% of the logic, and is tested directly. The hook only reads geometry and calls it.

---

### Task 1: Consent document list

**Files:**

- Create: `apps/web/src/components/consent/consent-docs.ts`
- Test: `apps/web/src/__tests__/components/consent-docs.test.ts`

**Interfaces:**

- Consumes: `ConsentDocContent`, `ParticipantConsent` from `apps/web/src/components/consent/consent-types.ts`.
- Produces: `export interface ConsentDoc { id: string; cap: string; title: string; body: string }` and `export function toConsentDocs(content: ConsentDocContent | ParticipantConsent | undefined): ConsentDoc[]`.

`cap` is the short label under a tracker dot. Order is always privacy → terms → profile, matching Signals' `initialTab="privacy"`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { toConsentDocs } from '@/components/consent/consent-docs';
import type { ParticipantConsent } from '@/components/consent/consent-types';

const base = {
  terms: { version: 1, title: 'Terms of Service', content: '## Terms body' },
  privacy: { version: 1, title: 'Privacy Policy', content: '## Privacy body' },
};

describe('toConsentDocs', () => {
  it('returns privacy then terms for plain consent content', () => {
    const docs = toConsentDocs(base);
    expect(docs.map((d) => d.id)).toEqual(['privacy', 'terms']);
    expect(docs[0]!.title).toBe('Privacy Policy');
    expect(docs[0]!.body).toBe('## Privacy body');
  });

  it('appends the profile-creation statement when present', () => {
    const withProfile: ParticipantConsent = {
      ...base,
      profileCreation: { version: 1, statement: 'Used to match you with services.' },
    };
    const docs = toConsentDocs(withProfile);
    expect(docs.map((d) => d.id)).toEqual(['privacy', 'terms', 'profile']);
    expect(docs[2]!.body).toBe('Used to match you with services.');
  });

  it('returns an empty list when content is missing', () => {
    expect(toConsentDocs(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/components/consent-docs.test.ts`
Expected: FAIL — cannot resolve `@/components/consent/consent-docs`.

- [ ] **Step 3: Write minimal implementation**

```ts
/**
 * Builds the ordered document list the consent gate reads.
 *
 * Order is fixed privacy → terms → profile so the tracker reads the same on
 * every surface and matches Signals' `initialTab="privacy"`.
 *
 * @module apps/web/src/components/consent/consent-docs
 */
import type { ConsentDocContent, ParticipantConsent } from './consent-types';

/** One document in the guided read. `cap` labels its tracker dot. */
export interface ConsentDoc {
  id: string;
  cap: string;
  title: string;
  body: string;
}

/**
 * Flattens consent content into the ordered list the gate renders.
 *
 * @param content - Consent copy, or undefined when the loader failed at boot.
 * @returns Ordered documents; empty when there is nothing to show.
 */
export function toConsentDocs(
  content: ConsentDocContent | ParticipantConsent | undefined,
): ConsentDoc[] {
  if (!content) return [];
  const docs: ConsentDoc[] = [
    { id: 'privacy', cap: 'Privacy', title: content.privacy.title, body: content.privacy.content },
    { id: 'terms', cap: 'Terms', title: content.terms.title, body: content.terms.content },
  ];
  const profile = (content as ParticipantConsent).profileCreation;
  if (profile) {
    docs.push({
      id: 'profile',
      cap: 'Profile',
      title: 'Profile creation',
      body: profile.statement,
    });
  }
  return docs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/components/consent-docs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/consent/consent-docs.ts apps/web/src/__tests__/components/consent-docs.test.ts
git commit -m "feat(consent): build the ordered consent document list for the gate (#636)"
```

---

### Task 2: Read-progress logic

**Files:**

- Create: `apps/web/src/components/consent/read-progress.ts`
- Test: `apps/web/src/__tests__/components/read-progress.test.ts`

**Interfaces:**

- Consumes: `ConsentDoc` from Task 1.
- Produces:
  - `export interface SectionBox { id: string; top: number; height: number }`
  - `export interface ScrollBox { scrollTop: number; clientHeight: number; scrollHeight: number }`
  - `export interface ReadProgress { readIds: string[]; currentId: string | null; fillPercent: number; allRead: boolean }`
  - `export function computeReadProgress(scroll: ScrollBox, sections: SectionBox[], alreadyRead: readonly string[]): ReadProgress`
  - `export function useReadProgress(scrollRef: RefObject<HTMLElement | null>, docs: ConsentDoc[]): ReadProgress`

Rules the pure function encodes:

1. A section is read once `scrollTop + clientHeight >= top + height - TOLERANCE`.
2. If the container cannot scroll (`scrollHeight <= clientHeight + TOLERANCE`), **every** section is read. This is what stops the 111-character profile statement bricking registration.
3. Read state is sticky — `alreadyRead` ids are never dropped.
4. `currentId` is the first unread section, `null` when all are read.
5. `fillPercent = min(100, (readCount + fractionOfCurrent) / max(1, sections.length - 1) * 100)`.

`TOLERANCE` is `8` — absorbs fractional device pixel ratios and iOS momentum overscroll, where `scrollTop + clientHeight` lands a pixel short of `scrollHeight`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { computeReadProgress } from '@/components/consent/read-progress';

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/components/read-progress.test.ts`
Expected: FAIL — cannot resolve `@/components/consent/read-progress`.

- [ ] **Step 3: Write minimal implementation**

```ts
'use client';
/**
 * Scroll-gating logic for the consent gate.
 *
 * All decisions live in {@link computeReadProgress}, a pure function over plain
 * numbers. jsdom performs no layout — every offset and scroll property reads 0
 * — so testing this through the DOM would mean stubbing geometry on every
 * element. Keeping the logic pure makes it directly testable; the hook only
 * measures and delegates.
 *
 * @module apps/web/src/components/consent/read-progress
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ConsentDoc } from './consent-docs';

/**
 * Slack when comparing scroll offsets, in CSS pixels. Fractional device pixel
 * ratios and iOS momentum overscroll both leave `scrollTop + clientHeight` a
 * pixel or so short of `scrollHeight`; exact equality would never fire.
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
 * @param alreadyRead - Ids already read; never dropped, so scrolling back up
 *   cannot un-read a document.
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

  const viewBottom = scroll.scrollTop + scroll.clientHeight;
  // Content that cannot scroll has, by definition, already been shown in full.
  // Without this a document shorter than the viewport — the 111-character
  // profile statement — would never be markable as read and would lock the
  // form permanently on every network.
  const unscrollable = scroll.scrollHeight <= scroll.clientHeight + TOLERANCE;

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
  const segments = Math.max(1, sections.length - 1);
  const fillPercent = Math.min(100, ((readIds.length + fractionOfCurrent) / segments) * 100);

  return { readIds, currentId, fillPercent, allRead: readIds.length === sections.length };
}

/**
 * Tracks read progress for a scroll container holding `docs` in order.
 *
 * Re-measures on scroll and on resize: a web-font swap, async Markdown render,
 * or orientation change all move the geometry after first paint.
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
  const [progress, setProgress] = useState<ReadProgress>(() =>
    computeReadProgress({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 }, [], []),
  );

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sections: SectionBox[] = [];
    for (const doc of docs) {
      const node = el.querySelector<HTMLElement>(`[data-consent-section="${doc.id}"]`);
      if (node) sections.push({ id: doc.id, top: node.offsetTop, height: node.offsetHeight });
    }
    const next = computeReadProgress(
      { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight },
      sections,
      readRef.current,
    );
    readRef.current = next.readIds;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/components/read-progress.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/consent/read-progress.ts apps/web/src/__tests__/components/read-progress.test.ts
git commit -m "feat(consent): add scroll read-progress logic with an unscrollable-content guard (#636)"
```

---

### Task 3: Progress tracker

**Files:**

- Create: `apps/web/src/components/consent/ConsentProgressTracker.tsx`
- Test: `apps/web/src/__tests__/components/ConsentProgressTracker.test.tsx`

**Interfaces:**

- Consumes: `ConsentDoc` (Task 1), `ReadProgress` (Task 2).
- Produces: `export function ConsentProgressTracker(props: { docs: ConsentDoc[]; progress: ReadProgress }): JSX.Element | null`.

Each dot carries `data-consent-node="<id>"` and `data-state="todo" | "current" | "read"` so tests assert state without depending on classes.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConsentProgressTracker } from '@/components/consent/ConsentProgressTracker';
import type { ConsentDoc } from '@/components/consent/consent-docs';

const docs: ConsentDoc[] = [
  { id: 'privacy', cap: 'Privacy', title: 'Privacy Policy', body: 'p' },
  { id: 'terms', cap: 'Terms', title: 'Terms of Service', body: 't' },
];

describe('<ConsentProgressTracker />', () => {
  it('marks the first document current and the rest todo at the start', () => {
    render(
      <ConsentProgressTracker
        docs={docs}
        progress={{ readIds: [], currentId: 'privacy', fillPercent: 0, allRead: false }}
      />,
    );
    expect(screen.getByTestId('consent-node-privacy')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('consent-node-terms')).toHaveAttribute('data-state', 'todo');
  });

  it('marks read documents read and reflects fill on the connecting line', () => {
    render(
      <ConsentProgressTracker
        docs={docs}
        progress={{ readIds: ['privacy'], currentId: 'terms', fillPercent: 50, allRead: false }}
      />,
    );
    expect(screen.getByTestId('consent-node-privacy')).toHaveAttribute('data-state', 'read');
    expect(screen.getByTestId('consent-node-terms')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('consent-progress-fill')).toHaveStyle({ width: '50%' });
  });

  it('renders nothing for a single document — a tracker of one conveys nothing', () => {
    const { container } = render(
      <ConsentProgressTracker
        docs={[docs[0]!]}
        progress={{ readIds: [], currentId: 'privacy', fillPercent: 0, allRead: false }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/components/ConsentProgressTracker.test.tsx`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Write minimal implementation**

```tsx
'use client';
/**
 * Progress tracker for {@link ConsentGate}: one dot per document, joined by a
 * line that fills as the reader advances.
 *
 * Presentational only — all state arrives via `progress`.
 *
 * @module apps/web/src/components/consent/ConsentProgressTracker
 */
import { Check } from 'lucide-react';
import type { ConsentDoc } from './consent-docs';
import type { ReadProgress } from './read-progress';

/** Props for {@link ConsentProgressTracker}. */
export interface ConsentProgressTrackerProps {
  docs: ConsentDoc[];
  progress: ReadProgress;
}

/**
 * Renders the per-document progress dots and the connecting fill line.
 *
 * @param props - Documents in order plus current read progress.
 * @returns The tracker, or null when there are fewer than two documents.
 */
export function ConsentProgressTracker({
  docs,
  progress,
}: ConsentProgressTrackerProps): JSX.Element | null {
  // A tracker with one node reports nothing the reader cannot already see.
  if (docs.length < 2) return null;

  return (
    <div className="relative mx-auto flex max-w-[340px] items-start justify-between px-1.5 pt-0.5">
      <div className="absolute left-[16.67%] right-[16.67%] top-[9px] h-0.5 overflow-hidden rounded-sm bg-slate-300">
        <div
          data-testid="consent-progress-fill"
          className="h-full bg-(--bd-primary-600) transition-[width] duration-100 ease-linear"
          style={{ width: `${progress.fillPercent}%` }}
        />
      </div>
      {docs.map((doc) => {
        const state = progress.readIds.includes(doc.id)
          ? 'read'
          : doc.id === progress.currentId
            ? 'current'
            : 'todo';
        return (
          <div
            key={doc.id}
            data-testid={`consent-node-${doc.id}`}
            data-consent-node={doc.id}
            data-state={state}
            className="relative z-10 flex flex-1 flex-col items-center gap-1.5"
          >
            <span
              className={`grid h-5 w-5 place-items-center rounded-full border-2 transition-colors ${
                state === 'read'
                  ? 'border-(--bd-primary-600) bg-(--bd-primary-600)'
                  : state === 'current'
                    ? 'border-(--bd-primary-600) bg-white ring-4 ring-(--bd-primary-600)/20'
                    : 'border-slate-300 bg-white'
              }`}
            >
              {state === 'read' && <Check className="h-3 w-3 text-white" aria-hidden="true" />}
            </span>
            <span
              className={`text-[10.5px] font-semibold ${
                state === 'todo' ? 'text-ink-500' : 'text-ink-900'
              }`}
            >
              {doc.cap}
            </span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/components/ConsentProgressTracker.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/consent/ConsentProgressTracker.tsx apps/web/src/__tests__/components/ConsentProgressTracker.test.tsx
git commit -m "feat(consent): add the per-document consent progress tracker (#636)"
```

---

### Task 4: The gate itself

**Files:**

- Create: `apps/web/src/components/consent/ConsentGate.tsx`
- Modify: `apps/web/src/i18n/messages/en.json`, `hi.json`, `kn.json`
- Test: `apps/web/src/__tests__/components/ConsentGate.test.tsx`

**Interfaces:**

- Consumes: `ConsentDoc` (Task 1), `useReadProgress` (Task 2), `ConsentProgressTracker` (Task 3), existing `MarkdownContent` from `apps/web/src/components/forms/MarkdownContent`.
- Produces:

```ts
export interface ConsentGateProps {
  open: boolean;
  docs: ConsentDoc[];
  agreeLabel: string;
  onAccept: () => void;
  onCancel?: () => void;
}
export function ConsentGate(props: ConsentGateProps): JSX.Element | null;
```

Behaviour:

- Renders nothing when `open` is false or `docs` is empty. An empty list means consent copy failed to load; the caller keeps its existing fallback rather than showing an empty modal.
- Esc and backdrop click do **not** dismiss.
- `onCancel`, when supplied, renders an explicit close button. Deliberate exit is allowed; accidental loss is not. Signals passes no equivalent because its gate interrupts an auth redirect with nothing to return to; the aggregator's interrupts a form the user still owns.
- Checkbox is `disabled` until `allRead`; the CTA is `disabled` until the checkbox is ticked.
- Each section carries `data-consent-section="<id>"` — this is the hook's measurement contract from Task 2.

Copy lives in a shared top-level `consent_gate` namespace so every surface reads the same words. Only `agreeLabel` varies per surface.

- [ ] **Step 1: Add the i18n keys**

Add to `apps/web/src/i18n/messages/en.json` as a new top-level key:

```json
"consent_gate": {
  "eyebrow": "Before you continue",
  "title": "Review & accept to continue",
  "description": "Read straight through — the tracker follows as you go.",
  "hint_scroll": "Scroll to the end to unlock the checkbox.",
  "hint_done": "You have reached the end — you can agree now.",
  "accept": "Accept & continue",
  "close": "Close"
}
```

`hi.json`:

```json
"consent_gate": {
  "eyebrow": "जारी रखने से पहले",
  "title": "जारी रखने के लिए समीक्षा करें और स्वीकार करें",
  "description": "पूरा पढ़ें — ट्रैकर आपके साथ चलता रहेगा।",
  "hint_scroll": "चेकबॉक्स सक्रिय करने के लिए अंत तक स्क्रॉल करें।",
  "hint_done": "आप अंत तक पहुँच गए हैं — अब आप सहमति दे सकते हैं।",
  "accept": "स्वीकार करें और जारी रखें",
  "close": "बंद करें"
}
```

`kn.json`:

```json
"consent_gate": {
  "eyebrow": "ಮುಂದುವರಿಯುವ ಮೊದಲು",
  "title": "ಮುಂದುವರಿಯಲು ಪರಿಶೀಲಿಸಿ ಮತ್ತು ಸ್ವೀಕರಿಸಿ",
  "description": "ಪೂರ್ತಿಯಾಗಿ ಓದಿ — ಟ್ರ್ಯಾಕರ್ ನಿಮ್ಮೊಂದಿಗೆ ಸಾಗುತ್ತದೆ.",
  "hint_scroll": "ಚೆಕ್‌ಬಾಕ್ಸ್ ಸಕ್ರಿಯಗೊಳಿಸಲು ಕೊನೆಯವರೆಗೆ ಸ್ಕ್ರಾಲ್ ಮಾಡಿ.",
  "hint_done": "ನೀವು ಕೊನೆಯನ್ನು ತಲುಪಿದ್ದೀರಿ — ಈಗ ಸಮ್ಮತಿಸಬಹುದು.",
  "accept": "ಸ್ವೀಕರಿಸಿ ಮತ್ತು ಮುಂದುವರಿಯಿರಿ",
  "close": "ಮುಚ್ಚಿ"
}
```

- [ ] **Step 2: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
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
 */
function stubScroller(scrollHeight: number, clientHeight: number, scrollTop = 0) {
  const el = screen.getByTestId('consent-reader');
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
  for (const doc of docs) {
    const section = el.querySelector<HTMLElement>(`[data-consent-section="${doc.id}"]`)!;
    const top = doc.id === 'privacy' ? 0 : 300;
    Object.defineProperty(section, 'offsetTop', { value: top, configurable: true });
    Object.defineProperty(section, 'offsetHeight', { value: 300, configurable: true });
  }
  return el;
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

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
    expect(screen.getByText('Scroll to the end to unlock the checkbox.')).toBeInTheDocument();
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
    expect(screen.getByText('You have reached the end — you can agree now.')).toBeInTheDocument();

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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/components/ConsentGate.test.tsx`
Expected: FAIL — cannot resolve `@/components/consent/ConsentGate`.

- [ ] **Step 4: Write minimal implementation**

```tsx
'use client';
/**
 * Blocking consent gate: every document in one continuous scroll, a progress
 * tracker above it, and a single agreement at the foot that unlocks only once
 * the reader has reached the end of the last document.
 *
 * Distinct from {@link ConsentModal}, which stays a dismissible read-only
 * viewer opened from inline links.
 *
 * @module apps/web/src/components/consent/ConsentGate
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, Check, X } from 'lucide-react';
import { MarkdownContent } from '../forms/MarkdownContent';
import { ConsentProgressTracker } from './ConsentProgressTracker';
import { useReadProgress } from './read-progress';
import type { ConsentDoc } from './consent-docs';

/** Props for {@link ConsentGate}. */
export interface ConsentGateProps {
  /** Whether the gate is showing. */
  open: boolean;
  /** Documents to read, in order. */
  docs: ConsentDoc[];
  /** Surface-specific agreement wording beside the checkbox. */
  agreeLabel: string;
  /** Called when the reader accepts. */
  onAccept: () => void;
  /** Optional deliberate exit. Omit to make the gate unexitable. */
  onCancel?: () => void;
}

/**
 * Renders the blocking consent gate.
 *
 * @param props - Open state, documents, agreement copy, and callbacks.
 * @returns The gate, or null when closed or there is nothing to show.
 */
export function ConsentGate({
  open,
  docs,
  agreeLabel,
  onAccept,
  onCancel,
}: ConsentGateProps): JSX.Element | null {
  const t = useTranslations('consent_gate');
  const readerRef = useRef<HTMLDivElement>(null);
  const [agreed, setAgreed] = useState(false);
  const progress = useReadProgress(readerRef, docs);

  // An empty list means the consent copy failed to load. Callers keep their
  // own fallback for that; an empty modal would be worse than none.
  if (!open || docs.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 p-0 sm:items-center sm:p-4">
      {/* Inert backdrop: present for the scrim only. Clicking it must not
          dismiss — losing a half-read consent flow by mis-tapping is worse
          than having to use the close button. */}
      <div data-testid="consent-gate-backdrop" className="absolute inset-0" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('title')}
        className="relative z-10 flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-[20px] bg-white shadow-2xl sm:max-w-lg sm:rounded-2xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 px-5 pb-3 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-wide text-(--bd-primary-600)">
              {t('eyebrow')}
            </p>
            <h2 className="mt-0.5 font-display text-xl font-bold leading-tight text-ink-900">
              {t('title')}
            </h2>
            <p className="mt-1 text-sm text-ink-500">{t('description')}</p>
          </div>
          {onCancel && (
            <button
              type="button"
              aria-label={t('close')}
              onClick={onCancel}
              className="shrink-0 rounded-lg p-1.5 text-ink-500 transition-colors hover:bg-slate-100 hover:text-ink-900"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="shrink-0 px-4 pb-1 pt-3 sm:px-6">
          <ConsentProgressTracker docs={docs} progress={progress} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-5 pt-3 sm:px-6">
          <div
            ref={readerRef}
            data-testid="consent-reader"
            className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-(--bd-border) bg-[#FBFCFF] p-4"
          >
            {docs.map((doc, i) => (
              <section
                key={doc.id}
                data-consent-section={doc.id}
                className={i > 0 ? 'mt-6 border-t border-slate-300 pt-5' : undefined}
              >
                <h3 className="mb-2 font-display text-[17px] font-bold text-ink-900">
                  {doc.title}
                </h3>
                <MarkdownContent content={doc.body} />
              </section>
            ))}
          </div>
        </div>

        <div className="mt-3 shrink-0 border-t border-(--bd-border) bg-[#FCFDFF] px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3 sm:px-6">
          <p
            className={`flex items-center gap-1.5 text-[11.5px] ${
              progress.allRead ? 'font-semibold text-emerald-600' : 'text-ink-500'
            }`}
          >
            {progress.allRead ? (
              <Check className="h-3 w-3 shrink-0" aria-hidden="true" />
            ) : (
              <ArrowDown className="h-3 w-3 shrink-0" aria-hidden="true" />
            )}
            {progress.allRead ? t('hint_done') : t('hint_scroll')}
          </p>

          <label
            className={`mt-2.5 flex items-start gap-3 rounded-xl border p-3 transition-colors ${
              progress.allRead
                ? 'border-(--bd-primary-600) bg-white'
                : 'border-(--bd-border) bg-slate-50 opacity-60'
            }`}
          >
            <input
              type="checkbox"
              checked={agreed}
              disabled={!progress.allRead}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-0.5 h-[19px] w-[19px] shrink-0 accent-(--bd-primary-600)"
            />
            <span className="text-[13px] leading-relaxed text-ink-700">{agreeLabel}</span>
          </label>

          <button
            type="button"
            disabled={!progress.allRead || !agreed}
            onClick={onAccept}
            className="mt-3 w-full rounded-xl bg-(--bd-primary-600) py-3.5 text-[15px] font-bold text-white transition-colors disabled:bg-(--bd-primary-200) disabled:text-white"
          >
            {t('accept')}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/components/ConsentGate.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 6: Confirm the read-only viewer is untouched**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/components/ConsentModal.test.tsx`
Expected: PASS — unchanged. `ConsentModal` must keep dismissing on Esc and backdrop.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/consent/ConsentGate.tsx apps/web/src/__tests__/components/ConsentGate.test.tsx apps/web/src/i18n/messages/en.json apps/web/src/i18n/messages/hi.json apps/web/src/i18n/messages/kn.json
git commit -m "feat(consent): add the blocking consent gate with scroll-to-end unlocking (#636)"
```

---

### Task 5: Registration forms — strip the inline consent block

**Files:**

- Modify: `apps/web/src/app/(public)/register/registration-shared.ts`
- Test: `apps/web/src/__tests__/app/(public)/register/registration-shared.test.ts`

**Interfaces:**

- Produces: `export function stripConsentBlock(schema: RJSFSchema): RJSFSchema`.

Removes `properties.consent` and drops `"consent"` from `required`, so RJSF neither renders the block nor blocks submit on it. The gate supplies the value at submit time. Mirrors the existing `stripFormChrome` pattern in the same file. **The on-disk schema files are not touched** — the server still requires `consent`.

- [ ] **Step 1: Write the failing test**

Append to the existing test file:

```ts
import { stripConsentBlock } from '@/app/(public)/register/registration-shared';

describe('stripConsentBlock', () => {
  const schema = {
    type: 'object',
    required: ['name', 'contact', 'consent'],
    properties: {
      name: { type: 'string' },
      contact: { type: 'object' },
      consent: { type: 'object', required: ['value'], properties: { value: { type: 'boolean' } } },
    },
  } as const;

  it('removes the consent property and its required entry', () => {
    const out = stripConsentBlock(schema as never);
    expect(out.properties).not.toHaveProperty('consent');
    expect(out.required).toEqual(['name', 'contact']);
  });

  it('leaves every other field untouched', () => {
    const out = stripConsentBlock(schema as never);
    expect(out.properties).toHaveProperty('name');
    expect(out.type).toBe('object');
  });

  it('does not mutate the schema it was given', () => {
    stripConsentBlock(schema as never);
    expect(schema.properties).toHaveProperty('consent');
    expect(schema.required).toContain('consent');
  });

  it('is a no-op on a schema with no consent block', () => {
    const bare = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
    expect(stripConsentBlock(bare as never)).toEqual(bare);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run "src/__tests__/app/(public)/register/registration-shared.test.ts"`
Expected: FAIL — `stripConsentBlock` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `registration-shared.ts`:

```ts
/**
 * Returns a copy of an RJSF schema with the `consent` block removed.
 *
 * Consent is collected by {@link ConsentGate} after the form is otherwise
 * valid, so the client-side schema must neither render the block nor gate
 * submit on it. The on-disk schema files are deliberately unchanged — the API
 * still requires `consent`, and the gate supplies it at submit time.
 *
 * @param schema - The loaded JSON Schema.
 * @returns A copy without the consent property or its `required` entry.
 */
export function stripConsentBlock(schema: RJSFSchema): RJSFSchema {
  const properties = { ...((schema.properties ?? {}) as Record<string, unknown>) };
  if (!('consent' in properties)) return schema;
  delete properties['consent'];
  const clone: RJSFSchema = { ...schema, properties: properties as RJSFSchema['properties'] };
  if (Array.isArray(schema.required)) {
    clone.required = schema.required.filter((k) => k !== 'consent');
  }
  return clone;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run "src/__tests__/app/(public)/register/registration-shared.test.ts"`
Expected: PASS — including the pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\(public\)/register/registration-shared.ts "apps/web/src/__tests__/app/(public)/register/registration-shared.test.ts"
git commit -m "feat(register): add stripConsentBlock so the gate owns consent collection (#636)"
```

---

### Task 6: Wire Org + Coordinator registration to the gate

**Files:**

- Modify: `apps/web/src/app/(public)/register/OrgRegisterForm.tsx`
- Modify: `apps/web/src/app/(public)/register/CoordinatorRegisterForm.tsx`
- Test: `apps/web/src/__tests__/app/(public)/register/register-page.test.tsx`

**Interfaces:**

- Consumes: `stripConsentBlock` (Task 5), `ConsentGate` (Task 4), `toConsentDocs` (Task 1).

Both forms change identically:

1. `formSchema` becomes `stripConsentBlock(stripFormChrome(schema))`.
2. New state `const [gateOpen, setGateOpen] = useState(false)` and `const pendingRef = useRef<Record<string, unknown> | null>(null)`.
3. `onSubmit` stores the form data on `pendingRef`, opens the gate, and returns without POSTing.
4. A new `submitWithConsent` performs the POST that `handleSubmit` used to, stamping `consent: stampConsent({ value: true })`.
5. `<ConsentGate>` is rendered alongside the form with `onAccept={submitWithConsent}` and `onCancel={() => setGateOpen(false)}`.

`agreeLabel` uses the existing `register.consent.*` keys: `` `${t('consent.accept_prefix')}${t('consent.privacy_link')}${t('consent.and')}${t('consent.terms_link')}.` ``

**Do not delete `ConsentCheckboxWidget`** — leave the widget registered in `RjsfThemed.tsx`. With the block stripped it simply never renders, and other schemas may still reference it.

- [ ] **Step 1: Write the failing test**

Append to `register-page.test.tsx`:

```tsx
it('opens the consent gate on submit instead of posting, then posts after accepting', async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    headers: new Headers(),
    json: async () => ({ aggregator_id: 'agg-1' }),
  });
  vi.stubGlobal('fetch', fetchMock);

  renderRegisterPage();
  await fillRequiredFields();

  fireEvent.click(screen.getByRole('button', { name: /register/i }));

  // Gate is showing and nothing has been sent yet.
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();

  // The inline consent block is gone from the form entirely.
  expect(screen.queryByText('Terms & Privacy Consent')).not.toBeInTheDocument();
});
```

> Reuse the file's existing render/fill helpers rather than inventing new ones; match their names to what is already in the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run "src/__tests__/app/(public)/register/register-page.test.tsx"`
Expected: FAIL — no dialog appears; the form posts directly.

- [ ] **Step 3: Implement in `CoordinatorRegisterForm.tsx`**

```tsx
// imports
import { useRef } from 'react';
import { ConsentGate } from '../../../components/consent/ConsentGate';
import { toConsentDocs } from '../../../components/consent/consent-docs';
import { stripConsentBlock } from './registration-shared';

// inside the component
const [gateOpen, setGateOpen] = useState(false);
const pendingRef = useRef<Record<string, unknown> | null>(null);
const consentDocs = useMemo(() => toConsentDocs(consentContent), [consentContent]);

const formSchema = useMemo(() => stripConsentBlock(stripFormChrome(schema)), [schema]);

const agreeLabel = `${t('consent.accept_prefix')}${t('consent.privacy_link')}${t('consent.and')}${t('consent.terms_link')}.`;

/** Holds the payload and opens the gate — consent is collected there. */
const handleSubmit = async (
  e: IChangeEvent<Record<string, unknown>>,
  _event: FormEvent<HTMLFormElement>,
): Promise<void> => {
  pendingRef.current = (e.formData ?? {}) as Record<string, unknown>;
  setGateOpen(true);
};

/** Runs after the gate is accepted: stamps consent and posts. */
const submitWithConsent = async (): Promise<void> => {
  setGateOpen(false);
  setState({ status: 'submitting' });
  const payload: Record<string, unknown> = {
    ...(pendingRef.current ?? {}),
    consent: stampConsent({ value: true }),
  };
  if (orgHierarchyEnabled && orgId) {
    payload['org_id'] = orgId;
    payload['name'] = selectedOrgName;
  }
  const result = await submitRegistration('/api/aggregator/register', payload);
  setState(
    result.ok
      ? { status: 'done', refId: String(result.body['aggregator_id'] ?? '') }
      : { status: 'error', ...result.error },
  );
};
```

Render the gate immediately after `</RjsfThemedForm>`:

```tsx
<ConsentGate
  open={gateOpen}
  docs={consentDocs}
  agreeLabel={agreeLabel}
  onAccept={submitWithConsent}
  onCancel={() => setGateOpen(false)}
/>
```

Also drop `consent: stampConsent(undefined)` from the `useState` initialiser for `formData` — the block no longer exists on the form.

- [ ] **Step 4: Implement the same in `OrgRegisterForm.tsx`**

Identical, except `submitWithConsent` posts to `/api/org/register`, has no `org_id`/`name` branch, and reads `slug` for the reference id:

```tsx
const submitWithConsent = async (): Promise<void> => {
  setGateOpen(false);
  setState({ status: 'submitting' });
  const payload: Record<string, unknown> = {
    ...(pendingRef.current ?? {}),
    consent: stampConsent({ value: true }),
  };
  const result = await submitRegistration('/api/org/register', payload);
  setState(
    result.ok
      ? { status: 'done', refId: String(result.body['slug'] ?? '') }
      : { status: 'error', ...result.error },
  );
};
```

> Check the existing `handleSubmit` in this file before writing — mirror its exact endpoint and success-field, do not assume.

- [ ] **Step 5: Run the register tests**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run "src/__tests__/app/(public)/register/"`
Expected: PASS, new case included.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/src/app/(public)/register/" "apps/web/src/__tests__/app/(public)/register/"
git commit -m "feat(register): collect org and coordinator consent through the gate (#636)"
```

---

### Task 7: Wire the public QR form (three documents)

**Files:**

- Modify: `apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx`
- Test: `apps/web/src/__tests__/views/PublicRegistrationView.consent-gate.test.tsx` (create)

**Interfaces:**

- Consumes: `ConsentGate` (Task 4), `toConsentDocs` (Task 1).

This surface has three documents and two behaviours that must survive:

- **`isMinor`** — minors skip consent entirely (`u18_notice` renders, submit proceeds). The gate must never open for a minor.
- **`showConsent`** — config-driven per domain. When false, no consent is collected and the gate must never open.

Changes:

1. Delete the inline `<div>` holding `consent-all` and its two link buttons (currently around lines 1012–1051), and the `profileConsentModal` block (around lines 1096–1130) — the profile statement is now a document inside the gate.
2. Keep `consentAccepted` state: it still feeds `consent_terms` / `consent_privacy` / `consent_profile` in the payload, and still gates the submit button.
3. Submit opens the gate when `showConsent && !isMinor && !consentAccepted`; accepting sets `consentAccepted` true and submits.
4. Keep the existing `ConsentModal` usages — the pre-form chooser from #653 still opens documents read-only.

`agreeLabel`: `` `${t('consent_accept_prefix')}${t('consent_docs_link')}${t('consent_profile_conjunction')}` `` — the existing copy, unchanged, which already covers all three consents in one sentence.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Follow the harness already used by PublicRegistrationView.signals-cta.test.tsx
// in this directory — reuse its provider wrapper and default props factory.

describe('<PublicRegistrationView /> consent gate', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it('renders no inline consent checkbox on the form', () => {
    renderView({ showConsent: true });
    expect(screen.queryByRole('checkbox', { name: /consent/i })).not.toBeInTheDocument();
  });

  it('opens the gate with all three documents when submitting without consent', async () => {
    renderView({ showConsent: true });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('consent-node-privacy')).toBeInTheDocument();
    expect(screen.getByTestId('consent-node-terms')).toBeInTheDocument();
    expect(screen.getByTestId('consent-node-profile')).toBeInTheDocument();
  });

  it('never opens the gate for a minor', () => {
    renderView({ showConsent: true, birthYear: new Date().getFullYear() - 15 });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never opens the gate when the domain does not require consent', () => {
    renderView({ showConsent: false });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
```

> Open `PublicRegistrationView.signals-cta.test.tsx` first and copy its exact mock and render setup. Do not invent `renderView` from scratch.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/views/PublicRegistrationView.consent-gate.test.tsx`
Expected: FAIL — inline checkbox still present, no dialog.

- [ ] **Step 3: Implement**

```tsx
const consentDocs = useMemo(() => toConsentDocs(consentContent), [consentContent]);
const [gateOpen, setGateOpen] = useState(false);
const needsConsent = showConsent && !isMinor && !consentAccepted;
const agreeLabel = `${t('consent_accept_prefix')}${t('consent_docs_link')}${t('consent_profile_conjunction')}`;
```

Replace the inline consent `<div>` with nothing (keep the `isMinor` `u18_notice` branch as-is). In the submit handler, before doing any work:

```tsx
if (needsConsent) {
  setGateOpen(true);
  return;
}
```

Render alongside the existing modals:

```tsx
<ConsentGate
  open={gateOpen}
  docs={consentDocs}
  agreeLabel={agreeLabel}
  onAccept={() => {
    setGateOpen(false);
    setConsentAccepted(true);
    void submitNow();
  }}
  onCancel={() => setGateOpen(false)}
/>
```

`submitNow` is the existing submit body extracted so it can run after the gate. The submit button's `blocked` expression stays exactly as it is — `consentAccepted` still gates it, so nothing regresses if the gate is bypassed.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/views/`
Expected: PASS — including the pre-existing `signals-cta`, `lookup`, and `config-failure` suites.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/[org]/[slug]/PublicRegistrationView.tsx" src/__tests__/views/PublicRegistrationView.consent-gate.test.tsx
git commit -m "feat(public-form): collect all three consents through the gate (#636)"
```

---

### Task 8: Wire the minimal identity form (two documents)

**Files:**

- Modify: `apps/web/src/app/[org]/[slug]/MinimalIdentityForm.tsx`
- Test: `apps/web/src/__tests__/views/MinimalIdentityForm.consent-gate.test.tsx` (create)

**Interfaces:**

- Consumes: `ConsentGate` (Task 4), `toConsentDocs` (Task 1).

This form's `consentCall` checkbox is a **different consent** — permission to trigger a voice call, not terms acceptance. **Leave it exactly as it is.** Only the terms/privacy line (currently the `<p>` with `consent_accept_prefix` and `consent_docs_link`, around lines 312–324) moves into the gate.

Note `MinimalIdentityForm` posts only `consent_terms` and `consent_privacy` — there is no profile document here, so `toConsentDocs` is given the plain `ConsentDocContent`, yielding two nodes.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

describe('<MinimalIdentityForm /> consent gate', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });

  it('keeps the call-permission checkbox on the form', () => {
    renderForm({ showConsent: true });
    expect(
      screen.getByRole('checkbox', { name: /permit the aggregator to trigger the call/i }),
    ).toBeInTheDocument();
  });

  it('opens a two-document gate on submit', async () => {
    renderForm({ showConsent: true });
    fireEvent.click(screen.getByRole('button', { name: /submit/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('consent-node-privacy')).toBeInTheDocument();
    expect(screen.getByTestId('consent-node-terms')).toBeInTheDocument();
    expect(screen.queryByTestId('consent-node-profile')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/views/MinimalIdentityForm.consent-gate.test.tsx`
Expected: FAIL — no dialog.

- [ ] **Step 3: Implement**

Mirror Task 7: remove the terms/privacy `<p>`, add `gateOpen` state, open the gate on submit when consent is outstanding, submit on accept. `agreeLabel` uses this form's own namespace:

```tsx
const agreeLabel = `${t('consent_accept_prefix')}${t('consent_docs_link')}.`;
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/views/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/[org]/[slug]/MinimalIdentityForm.tsx" src/__tests__/views/MinimalIdentityForm.consent-gate.test.tsx
git commit -m "feat(public-form): collect account-only consent through the gate (#636)"
```

---

### Task 9: Public legal pages

**Files:**

- Create: `apps/web/src/components/legal/legal-sections.ts`
- Create: `apps/web/src/components/legal/LegalDocumentView.tsx`
- Create: `apps/web/src/app/(public)/privacy/page.tsx`
- Create: `apps/web/src/app/(public)/terms/page.tsx`
- Test: `apps/web/src/__tests__/components/legal-sections.test.ts`
- Test: `apps/web/src/__tests__/components/LegalDocumentView.test.tsx`

**Interfaces:**

- Consumes: `loadConsentConfig` from `@aggregator-dpg/config-loader/fs` and
  `loadParticipantConsent` from `apps/web/src/lib/participant-consent.server` — both already
  used elsewhere; copy the exact call pattern from
  `apps/web/src/app/(public)/register/page.tsx` and `apps/web/src/app/[org]/[slug]/page.tsx`.
- Produces:

```ts
export interface LegalSection {
  id: string;
  heading: string;
  level: 2 | 3;
}
export function extractSections(markdown: string): LegalSection[];

export interface LegalGroup {
  audience: string;
  label: string;
  content: ConsentDocContent;
}
export function LegalDocumentView(props: {
  doc: 'privacy' | 'terms';
  groups: LegalGroup[];
}): JSX.Element;
```

Read-only. No checkbox, no scroll gating, no consent capture. The gate is untouched by this
task.

The rail groups by audience — **For participants**, **For aggregators**, **For
organisations** — because the aggregator carries three sets of documents and `/privacy`
alone would not say which. Section anchors make `/privacy#retention` work.

`extractSections` parses `##` and `###` headings out of the Markdown to build the rail.

**Rail structure — settled against the prototype:**

- The **group header is the navigation**: `PRIVACY POLICY` / `TERMS OF SERVICE` is itself the
  link to `/privacy` / `/terms`, carrying `aria-current` for the one being read.
- **Every section entry reads the same.** An earlier draft rendered the first section
  un-indented and darker, which implied it outranked the others. It does not — "Overview" is
  just another section. Uniform styling, one indent level.
- The group not being read is dimmed, not hidden.

Slugify to lowercase-hyphenated ids, deduplicating collisions with a numeric suffix. The
dedup guards against a heading repeated **within a single document** — `extractSections`
is called per document with a fresh `seen` map, so cross-document collisions cannot
arise. (An earlier draft of this plan claimed both Terms and Privacy carry a
"Grievances" heading and would therefore collide. That was wrong: only the Privacy
documents carry that heading, and per-document dedup means it could not collide anyway.
Keep the dedup as defensive code; do not repeat the false rationale.)

**Trap, found in the sibling repo — every real consent document opens with
`## <Document Title>`.** Verified across all six network schemas, both privacy and terms.
If you treat that leading heading as an ordinary section you will render the title twice
(once as the page `h1`, once as an `h2` directly beneath) and the rail will repeat its own
group-header label as its first section entry. Drop the leading heading when its text
matches the document's `title` field, compared case- and whitespace-insensitively. Do NOT
blanket-drop the first `##`: a document legitimately opening with `## Overview` would
lose that section. **And build your test fixtures with the real shape** — leading
`## Privacy Policy` / `## Terms of Service`. The sibling's fixture started with
`## Overview`, which is exactly why its tests passed while every real page was broken.

- [ ] **Step 1: Write the failing test for section extraction**

````ts
import { describe, it, expect } from 'vitest';
import { extractSections } from '@/components/legal/legal-sections';

describe('extractSections', () => {
  it('pulls level-2 and level-3 headings in document order', () => {
    const md = '## Privacy Policy\nintro\n### What we collect\nbody\n### Retention\nbody';
    expect(extractSections(md)).toEqual([
      { id: 'privacy-policy', heading: 'Privacy Policy', level: 2 },
      { id: 'what-we-collect', heading: 'What we collect', level: 3 },
      { id: 'retention', heading: 'Retention', level: 3 },
    ]);
  });

  it('ignores headings inside fenced code blocks', () => {
    const md = '## Real\n```\n## Not a heading\n```\n### Also real';
    expect(extractSections(md).map((s) => s.heading)).toEqual(['Real', 'Also real']);
  });

  it('deduplicates colliding ids — both documents have a Grievances section', () => {
    const md = '### Grievances\na\n### Grievances\nb';
    expect(extractSections(md).map((s) => s.id)).toEqual(['grievances', 'grievances-2']);
  });

  it('returns an empty list for content with no headings', () => {
    expect(extractSections('Just a sentence.')).toEqual([]);
  });
});
````

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/components/legal-sections.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `legal-sections.ts`**

````ts
/**
 * Pulls the section list out of a consent document's Markdown so the public
 * legal page can build a contents rail and anchor each heading.
 *
 * @module apps/web/src/components/legal/legal-sections
 */

/** One entry in the contents rail. */
export interface LegalSection {
  id: string;
  heading: string;
  level: 2 | 3;
}

/**
 * Converts a heading to a URL-safe anchor id.
 *
 * @param heading - Raw heading text.
 * @returns Lowercase hyphenated slug.
 */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Extracts `##` and `###` headings in document order.
 *
 * Fenced code blocks are skipped so a `#` inside an example is not mistaken
 * for a heading. Colliding slugs get a numeric suffix — both the Terms and the
 * Privacy Policy carry a "Grievances" section, so collisions happen in practice.
 *
 * @param markdown - The document body.
 * @returns Sections in order; empty when the document has no headings.
 */
export function extractSections(markdown: string): LegalSection[] {
  const out: LegalSection[] = [];
  const seen = new Map<string, number>();
  let inFence = false;

  for (const line of markdown.split('\n')) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^(#{2,3})\s+(.*)$/.exec(line.trim());
    if (!match) continue;

    const heading = match[2]!.trim();
    const base = slugify(heading);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);

    out.push({
      id: count === 1 ? base : `${base}-${count}`,
      heading,
      level: match[1]!.length === 2 ? 2 : 3,
    });
  }
  return out;
}
````

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/components/legal-sections.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing test for the view**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LegalDocumentView } from '@/components/legal/LegalDocumentView';

const groups = [
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
    render(<LegalDocumentView doc="privacy" groups={groups} />);
    expect(screen.getByText('For participants')).toBeInTheDocument();
    expect(screen.getByText('For aggregators')).toBeInTheDocument();
  });

  it('links each extracted section as an anchor', () => {
    render(<LegalDocumentView doc="privacy" groups={groups} />);
    expect(screen.getByRole('link', { name: 'Retention' })).toHaveAttribute('href', '#retention');
  });

  it('shows the version for each audience', () => {
    render(<LegalDocumentView doc="privacy" groups={groups} />);
    expect(screen.getByText(/Version 1/)).toBeInTheDocument();
    expect(screen.getByText(/Version 2/)).toBeInTheDocument();
  });

  it('captures no consent — there is no checkbox anywhere on the page', () => {
    render(<LegalDocumentView doc="terms" groups={groups} />);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('renders a helpful empty state when no consent content loaded', () => {
    render(<LegalDocumentView doc="privacy" groups={[]} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/components/LegalDocumentView.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `LegalDocumentView.tsx`**

Build the contents-rail layout: a `<nav>` rail listing one group per audience (group label,
then that audience's sections for the selected `doc`), beside a reading column rendering the
document with `MarkdownContent`. Each rail entry is an `<a href="#<id>">`. Each rendered
heading needs the matching `id` so the anchor lands — render headings yourself from
`extractSections` rather than relying on `MarkdownContent` to emit ids.

Requirements:

- Rail is `sticky` on `md:` and above; it stacks above the reading column below that.
- Reading measure capped around `max-w-[72ch]`.
- Version and effective date shown per audience group.
- `groups.length === 0` renders a `role="status"` message rather than a blank page.
- The other document is reachable from the rail as a link to `/privacy` or `/terms`.

Match the visual language of the approved prototype
(`~/KKB/Github/2026-08-20-public-legal-page-approaches.html`, approach B).

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @aggregator-dpg/web exec vitest run src/__tests__/components/LegalDocumentView.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 9: Add the two routes**

`apps/web/src/app/(public)/privacy/page.tsx`:

```tsx
import type { Metadata } from 'next';
import { LegalDocumentView } from '@/components/legal/LegalDocumentView';
import { loadLegalGroups } from '@/components/legal/load-legal-groups.server';

export const metadata: Metadata = { title: 'Privacy Policy' };
export const dynamic = 'force-dynamic';

export default async function PrivacyPage() {
  return <LegalDocumentView doc="privacy" groups={await loadLegalGroups()} />;
}
```

`terms/page.tsx` is identical with `doc="terms"` and the Terms title.

Add `load-legal-groups.server.ts` beside the view, marked `import 'server-only'`, assembling
the three audience groups. **Read the existing loaders first** —
`(public)/register/page.tsx` for `loadConsentConfig`, and `[org]/[slug]/page.tsx` for
`loadParticipantConsent` — and reuse their exact call shape. An audience whose content fails
to load is omitted from `groups` rather than throwing; a missing operator policy must not
take down the participant one.

- [ ] **Step 10: Verify the pages render**

Run `pnpm dev` and open `/privacy` and `/terms`. Confirm all three audience groups appear in
the rail, section links jump correctly, and the reading column is legible at a 390px width.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/components/legal "apps/web/src/app/(public)/privacy" "apps/web/src/app/(public)/terms" src/__tests__/components/legal-sections.test.ts src/__tests__/components/LegalDocumentView.test.tsx
git commit -m "feat(legal): add public privacy and terms pages with a contents rail (#636)"
```

---

### Task 10: Full verification and draft PR

**Files:** none created.

- [ ] **Step 1: Full package test run**

Run: `pnpm --filter @aggregator-dpg/web test`
Expected: 126+ files, 0 failures. Baseline before this work was 126 files / 924 tests, all passing.

- [ ] **Step 2: Lint, typecheck, dependency check**

```bash
pnpm lint
pnpm typecheck
pnpm dep-check
```

Expected: all clean. `dep-check` is a required CI step.

- [ ] **Step 3: Manual verification at both breakpoints**

Run `pnpm dev` and check, at desktop width **and** at a 390px phone viewport:

1. `/register` — no inline consent block; Register opens the gate; checkbox locked; scrolling to the end unlocks it; accepting submits.
2. A live QR link `/<org>/<slug>` — gate shows **three** nodes; the tracker line advances while scrolling, not in jumps.
3. On the phone viewport the gate is a bottom sheet, the tracker stays pinned, and the CTA is reachable above the home indicator.
4. Esc and backdrop click do not dismiss; the close button does.

Record what was checked in the PR description. **Do not claim mobile works without having looked at it.**

- [ ] **Step 4: Push and open the draft PR**

```bash
git push -u origin feat/636-consent-scroll-gate
gh pr create --draft --base feature \
  --title "feat(consent): standardise T&C acceptance behind a scroll-gated consent gate (#636)" \
  --body-file <(cat <<'BODY'
Closes #636 (aggregator side; Signals-DPG PR tracked separately).

## In Plain Terms

Before this change, someone signing up could tick "I accept the terms" without
ever opening them. Now, when they hit submit, the terms open in a window they
have to scroll through to the end. A row of dots along the top shows which
documents they have got through and how many are left. Only once they have
reached the bottom of the last one does the agree box become tickable.

Nothing about what we store changes — the same acceptance is recorded as
before. What changes is that people have to have seen the words first.

## Summary

- New `ConsentGate`: all consent documents in one continuous scroll with a
  progress tracker; the agreement unlocks only at the end.
- Applied to all four acceptance surfaces: org registration, coordinator
  registration, the public QR form (three documents), and the account-only QR
  form (two documents).
- Inline consent checkboxes removed from the registration forms; the `consent`
  block is stripped from the client schema only.
- The read-only `ConsentModal` is unchanged and still opens from inline links.

## Deliberately not changed

- **No JSON schema files.** `consent` stays `required` across all 10 files in 6
  config trees; the API still validates it server-side.
- **No API change**, so no `openapi.json` regeneration.
- **No change to what is recorded.** The same consent flags are sent as before.

## Notes for review

- The profile-creation consent is 111 characters and cannot scroll. Content
  shorter than its viewport counts as read, or registration would be impossible
  on every network. Covered by tests.
- Esc and backdrop click do not dismiss the gate; an explicit close button does.
  Signals' gate has no close because it interrupts an auth redirect with nothing
  to return to; this one interrupts a form the user still owns.
- Scroll position evidences reaching the end, not reading. This is a good-faith
  gate, not a compliance guarantee.

Spec: `docs/superpowers/specs/2026-08-20-consent-scroll-gate-design.md`
BODY
)
```

- [ ] **Step 5: Verify CI**

Run: `gh pr checks --watch`
Expected: green. Investigate any failure before handing over; do not report the PR as ready on a red build.

---

## Self-Review

**Spec coverage.** Gate mode → Tasks 2–4. All four aggregator surfaces → Tasks 6, 7, 8. Inline block removed / schema stripped client-side → Tasks 5, 6. No schema or API change → asserted in Global Constraints and Task 9. Mobile → Task 4 markup plus Task 9 Step 3. Short-document guard → Task 2 and Task 4 tests. Sticky read state → Task 2. Continuous fill → Tasks 2, 3. `view` mode untouched → Task 4 Step 6. i18n across three locales → Task 4 Step 1. Testing table → distributed across every task.

**Type consistency.** `ConsentDoc { id, cap, title, body }` is defined in Task 1 and used unchanged in Tasks 3, 4, 6, 7, 8. `ReadProgress { readIds, currentId, fillPercent, allRead }` is defined in Task 2 and consumed in Tasks 3 and 4. `toConsentDocs`, `computeReadProgress`, `useReadProgress`, `stripConsentBlock`, `ConsentGate` keep the same names throughout.

**Known gap.** Tasks 6, 7 and 8 tell the implementer to reuse each test file's existing render harness rather than restating it, because those harnesses are long and already in the files. This is the one place the plan points at existing code instead of reproducing it; the alternative was hundreds of lines of duplicated setup that would drift.
