'use client';

import type { ReactNode, JSX } from 'react';
import { I } from '../../icons';

/**
 * Inline hint that explains why a submit button is disabled.
 *
 * Renders nothing when `reasons` is empty. Each reason is a short, user-facing
 * sentence for one unmet requirement.
 */
export function SubmitBlockers({
  reasons,
  heading,
}: {
  reasons: string[];
  /** Optional lead-in line, e.g. "To create the link:". */
  heading?: ReactNode;
}): JSX.Element | null {
  if (reasons.length === 0) return null;
  return (
    <output
      aria-live="polite"
      className="block rounded-[10px] border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-800"
    >
      <div className="flex items-start gap-2">
        <I.alert size={14} className="mt-0.5 shrink-0 text-amber-600" />
        <div>
          {heading && <div className="font-semibold mb-0.5">{heading}</div>}
          <ul className="list-disc pl-4 space-y-0.5">
            {reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      </div>
    </output>
  );
}
