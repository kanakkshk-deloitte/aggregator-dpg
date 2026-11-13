/**
 * Button styles shared by `<Button>` and by links that should look like a
 * button. A plain module (not `'use client'`), so server components can call
 * {@link buttonClass} too.
 */

import { cn } from '../../lib/cn';

/** The button styles. */
export type ButtonKind = 'primary' | 'ghost' | 'soft' | 'danger';

const kindStyles: Record<ButtonKind, string> = {
  primary: 'bg-primary text-white hover:bg-primary-600 bd-shadow',
  ghost: 'bg-white text-ink-700 border border-(--bd-border) hover:bg-ink-50',
  soft: 'bg-(--bd-primary-50) text-primary-600 hover:bg-(--bd-primary-100)',
  danger: 'bg-rose-50 text-rose-700 hover:bg-rose-100',
};

/**
 * The classes of a button of `kind`.
 *
 * @param kind - The button style.
 * @param className - Extra classes.
 * @returns The class list.
 */
export function buttonClass(kind: ButtonKind = 'primary', className?: string): string {
  return cn(
    'inline-flex items-center gap-2 px-3.5 py-2 rounded-[10px] text-[13.5px] font-medium transition-all',
    // Disabled state needs a visible cue — without it the button looks
    // clickable but the native `disabled` silently swallows the click.
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
    kindStyles[kind],
    className,
  );
}
