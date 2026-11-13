/**
 * Small building blocks the console pages share, styled like the coordinator
 * portal (`bd-card`, the status pills, the muted labels). No client state, so
 * they render in server and client components alike.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { I } from '../../icons';
import { cn } from '../../lib/cn';

/** A registration status of a coordinator or an organisation. */
export type ConsoleStatus = 'pending' | 'active' | 'inactive' | 'retired';

const PILL: Record<ConsoleStatus, { dot: string; bg: string; text: string }> = {
  pending: { dot: '#F59E0B', bg: '#FFFBEB', text: '#B45309' },
  active: { dot: '#10B981', bg: '#ECFDF5', text: '#047857' },
  inactive: { dot: '#F43F5E', bg: '#FFF1F2', text: '#BE123C' },
  retired: { dot: '#94A3B8', bg: '#F1F5F9', text: '#475569' },
};

/**
 * A status as a coloured pill, labelled from `console.status` ("Rejected" for
 * `inactive`).
 *
 * @param props.status - The status.
 */
export function ConsoleStatusPill({ status }: { status: ConsoleStatus }) {
  const t = useTranslations('console');
  const s = PILL[status] ?? PILL.retired;
  return (
    <span
      data-testid="status-pill"
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap"
      style={{ background: s.bg, color: s.text }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.dot }} />
      {t(`status.${status}`)}
    </span>
  );
}

/**
 * A card with a titled header row, the console's section container.
 *
 * @param props.title - The section title.
 * @param props.action - Rendered at the right of the header (a button or link).
 * @param props.flush - Body without padding, for a table.
 */
export function ConsoleSection({
  title,
  action,
  flush = false,
  className,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  flush?: boolean;
  className?: string;
  /** Omitted (or null) for a header-only card. */
  children?: ReactNode;
}) {
  return (
    <section className={cn('bd-card bd-shadow overflow-hidden', className)}>
      {title || action ? (
        <header
          className={cn(
            'flex flex-wrap items-center justify-between gap-3 px-5 py-4',
            children ? 'border-b border-(--bd-border-soft)' : '',
          )}
        >
          {title ? (
            <h2 className="font-display font-bold text-[16px] text-ink-900">{title}</h2>
          ) : (
            <span />
          )}
          {action}
        </header>
      ) : null}
      {children ? <div className={flush ? '' : 'p-5'}>{children}</div> : null}
    </section>
  );
}

/**
 * A console section that starts closed and opens on a click on its header.
 *
 * Built on `<details>`, so it works without client code and is keyboard
 * accessible.
 *
 * @param props.title - The section title.
 * @param props.hint - Short text at the right of the header, e.g. a count.
 */
export function ConsoleCollapsible({
  title,
  description,
  hint,
  flush = false,
  children,
}: Readonly<{
  title: ReactNode;
  /** A line under the title. */
  description?: ReactNode;
  hint?: ReactNode;
  /** Drop the body padding, for content that lays out its own. */
  flush?: boolean;
  children: ReactNode;
}>) {
  return (
    <details className="group bd-card bd-shadow overflow-hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 select-none hover:bg-ink-50 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <I.chevR
            size={16}
            className="shrink-0 text-ink-400 transition-transform group-open:rotate-90"
            aria-hidden
          />
          <span>
            <h2 className="font-display font-bold text-[16px] text-ink-900">{title}</h2>
            {description ? <p className="text-[13px] text-ink-500">{description}</p> : null}
          </span>
        </span>
        {hint ? <span className="text-[12.5px] text-ink-500">{hint}</span> : null}
      </summary>
      <div className={cn('border-t border-(--bd-border-soft)', flush ? '' : 'p-5')}>{children}</div>
    </details>
  );
}

/**
 * Label / value pairs in a responsive grid.
 *
 * @param props.items - The pairs, in order.
 */
export function DetailList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-[11px] uppercase tracking-[0.06em] font-semibold text-(--bd-fg-muted)">
            {i.label}
          </dt>
          <dd className="mt-1 text-[14px] text-ink-900 wrap-break-word">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The "back to the list" link above a detail page's header.
 *
 * @param props.href - Where it goes.
 * @param props.children - Its label.
 */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 mb-3 text-[13px] font-medium text-(--bd-fg-muted) hover:text-primary-600 transition-colors"
    >
      <I.arrowL size={14} />
      {children}
    </Link>
  );
}

/**
 * A muted line for an empty list or a hint.
 *
 * @param props.children - The text.
 */
export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-5 py-8 text-center text-[13.5px] text-ink-500">{children}</p>;
}
