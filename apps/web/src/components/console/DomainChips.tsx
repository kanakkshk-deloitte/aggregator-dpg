'use client';

/**
 * The domains a coordinator serves, as chips. Names come from the network
 * configuration, so every network and domain renders the same way.
 */

import { Tag } from 'lucide-react';

/** One served domain. */
export interface ServedDomain {
  id: string;
  label: string;
}

/** The domains a coordinator serves as chips. */
export function DomainChips({ domains }: Readonly<{ domains: ServedDomain[] }>) {
  if (domains.length === 0) return <span className="text-ink-400">—</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {domains.map((d) => {
        return (
          <span
            key={d.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-(--bd-border) bg-(--bd-card) px-2.5 py-1 text-[12px] font-semibold text-ink-700"
          >
            <Tag size={13} aria-hidden="true" className="text-(--bd-primary-600)" />
            {d.label}
          </span>
        );
      })}
    </div>
  );
}
