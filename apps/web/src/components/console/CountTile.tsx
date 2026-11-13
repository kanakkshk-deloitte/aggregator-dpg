'use client';

/**
 * A console count tile: a label, a large number, a short line and a tinted
 * icon. As a button it filters a list on the page; as a link it opens the
 * list elsewhere; with neither it only shows the count. The selected tile is
 * tinted in its own colour.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { cn } from '../../lib/cn';

/** The colour of a tile, by what it counts. */
export type TileTone = 'primary' | 'green' | 'amber' | 'rose';

const TONE: Record<TileTone, { badge: string; count: string; selected: string }> = {
  primary: {
    badge: 'bg-(--bd-primary-50) text-(--bd-primary-600)',
    count: 'text-ink-900',
    selected:
      'border-(--bd-primary) bg-(--bd-primary)/8 shadow-[0_0_0_3px_var(--bd-primary-50)] hover:border-(--bd-primary)',
  },
  green: {
    badge: 'bg-emerald-50 text-emerald-600',
    count: 'text-ink-900',
    selected:
      'border-emerald-500 bg-emerald-500/8 shadow-[0_0_0_3px_rgb(16_185_129/0.15)] hover:border-emerald-500',
  },
  amber: {
    badge: 'bg-amber-50 text-amber-600',
    count: 'text-amber-600',
    selected:
      'border-amber-500 bg-amber-500/8 shadow-[0_0_0_3px_rgb(245_158_11/0.15)] hover:border-amber-500',
  },
  rose: {
    badge: 'bg-rose-50 text-rose-600',
    count: 'text-ink-900',
    selected:
      'border-rose-500 bg-rose-500/8 shadow-[0_0_0_3px_rgb(244_63_94/0.15)] hover:border-rose-500',
  },
};

const BASE = 'bd-card bd-shadow flex items-start justify-between gap-3 px-[18px] py-4 text-left';
const INTERACTIVE =
  'group cursor-pointer transition-[background-color,border-color,box-shadow,transform] duration-300 ease-out hover:-translate-y-px hover:border-(--bd-primary-100) hover:shadow-md focus-visible:outline-2 focus-visible:outline-(--bd-primary) active:scale-[0.98] motion-reduce:transition-none';

export function CountTile({
  icon,
  tone,
  label,
  count,
  sub,
  muted = false,
  selected = false,
  showLabel,
  showingLabel,
  onClick,
  href,
}: Readonly<{
  /** The icon element, sized 20 (an element, so server pages can pass it). */
  icon: ReactNode;
  tone: TileTone;
  label: string;
  count: string;
  sub: string;
  /** Grey number, for a count that needs no attention (such as nothing pending). */
  muted?: boolean;
  selected?: boolean;
  /** The hint on an unselected tile, such as "View list". */
  showLabel?: string;
  /** The hint on the selected tile, such as "Showing below". */
  showingLabel?: string;
  /** Makes the tile a button that filters this page. */
  onClick?: () => void;
  /** Makes the tile a link to another page. */
  href?: string;
}>) {
  const look = TONE[tone];
  let hint: ReactNode = null;
  if (selected && showingLabel) {
    hint = (
      <span className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-(--bd-primary-600)">
        <Check size={13} aria-hidden="true" />
        {showingLabel}
      </span>
    );
  } else if (showLabel) {
    hint = (
      <span className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-(--bd-primary-600) opacity-80 group-hover:opacity-100">
        {showLabel}
        <ArrowRight
          size={13}
          aria-hidden="true"
          className="transition-transform group-hover:translate-x-0.5"
        />
      </span>
    );
  }
  const body: ReactNode = (
    <>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] font-semibold text-ink-500">{label}</span>
        <span
          className={cn(
            'font-display text-[28px] font-extrabold leading-tight',
            muted ? 'text-ink-400' : look.count,
          )}
        >
          {count}
        </span>
        <span className="text-[12px] text-ink-400">{sub}</span>
        {hint}
      </span>
      <span
        aria-hidden="true"
        className={cn('grid h-10 w-10 flex-none place-items-center rounded-[11px]', look.badge)}
      >
        {icon}
      </span>
    </>
  );
  const className = cn(BASE, INTERACTIVE, selected && look.selected);
  if (href) {
    return (
      <Link href={href} className={cn(className, 'text-inherit no-underline hover:no-underline')}>
        {body}
      </Link>
    );
  }
  if (!onClick) {
    return <div className={BASE}>{body}</div>;
  }
  return (
    <button type="button" aria-pressed={selected} onClick={onClick} className={className}>
      {body}
    </button>
  );
}
