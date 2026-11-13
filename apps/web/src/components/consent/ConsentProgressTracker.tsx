'use client';
/**
 * Progress tracker for {@link ConsentGate}: one dot per document, joined by a
 * line that fills as the reader advances.
 *
 * Presentational only — all state arrives via `progress`.
 *
 * @module apps/web/src/components/consent/ConsentProgressTracker
 */
import type { JSX } from 'react';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ConsentDoc } from './consent-docs';
import type { ReadProgress } from './read-progress';

/** Props for {@link ConsentProgressTracker}. */
export interface ConsentProgressTrackerProps {
  docs: ConsentDoc[];
  progress: ReadProgress;
}

/** How one document's dot renders: read, currently in hand, or not yet reached. */
type NodeState = 'read' | 'current' | 'todo';

/**
 * Classifies one document's tracker node against current read progress.
 *
 * @param docId - The document's id.
 * @param progress - Current read progress across the whole stack.
 * @returns Whether the node is read, current, or still to do.
 */
function nodeState(docId: string, progress: ReadProgress): NodeState {
  if (progress.readIds.includes(docId)) return 'read';
  if (docId === progress.currentId) return 'current';
  return 'todo';
}

/**
 * Dot styling per node state. A keyed record, so a new state is a type error
 * until styled.
 */
const DOT_CLASS: Record<NodeState, string> = {
  read: 'border-(--bd-primary-600) bg-(--bd-primary-600)',
  current: 'border-(--bd-primary-600) bg-white ring-4 ring-(--bd-primary-600)/20',
  todo: 'border-slate-300 bg-white',
};

/**
 * Renders the per-document progress dots and the connecting fill line.
 *
 * @param props - Documents in order plus current read progress.
 * @returns The tracker, or null when there are fewer than two documents.
 */
export function ConsentProgressTracker({
  docs,
  progress,
}: Readonly<ConsentProgressTrackerProps>): JSX.Element | null {
  const t = useTranslations('consent_gate');

  // A tracker with one node reports nothing the reader cannot already see.
  if (docs.length < 2) return null;

  // The line runs from the first dot's centre to the last. With `n` equal
  // nodes, the first centre is `50 / n` percent from the left.
  const inset = 50 / docs.length;

  return (
    <div className="relative flex w-full items-start justify-between px-1.5 pt-0.5">
      <div
        data-testid="consent-progress-track"
        className="absolute top-[9px] h-0.5 overflow-hidden rounded-sm bg-slate-300"
        style={{ left: `${inset}%`, right: `${inset}%` }}
      >
        <div
          data-testid="consent-progress-fill"
          className="h-full bg-(--bd-primary-600) transition-[width] duration-100 ease-linear"
          style={{ width: `${progress.fillPercent}%` }}
        />
      </div>
      {docs.map((doc) => {
        const state = nodeState(doc.id, progress);
        // Falls back to `cap` when no translation key exists.
        const capKey = `cap_${doc.id}`;
        const label = t.has(capKey) ? t(capKey) : doc.cap;
        return (
          <div
            key={doc.id}
            data-testid={`consent-node-${doc.id}`}
            data-consent-node={doc.id}
            data-state={state}
            className="relative z-10 flex flex-1 flex-col items-center gap-1.5"
          >
            <span
              className={`grid h-5 w-5 place-items-center rounded-full border-2 transition-colors ${DOT_CLASS[state]}`}
            >
              {state === 'read' && <Check className="h-3 w-3 text-white" aria-hidden="true" />}
            </span>
            <span
              className={`text-[10.5px] font-semibold ${
                state === 'todo' ? 'text-ink-500' : 'text-ink-900'
              }`}
            >
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
