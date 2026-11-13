'use client';

/**
 * A dropdown that can also be searched: clicking opens the full list, typing
 * narrows it. Built on the Radix popover, styled like `Select`.
 *
 * Keyboard: ArrowUp/ArrowDown move through the list, Enter picks, Escape closes.
 */

import * as React from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '../../lib/cn';

/** One choice: what is shown, and an optional note on the right (also searched). */
export interface SearchableOption {
  value: string;
  label: string;
  hint?: string | null;
}

export interface SearchableSelectProps {
  id: string;
  options: readonly SearchableOption[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder: string;
  /** Shown when the search matches nothing. */
  emptyText: string;
}

/** Whether an option's label or hint contains the search text (case-insensitive). */
function matches(option: SearchableOption, query: string): boolean {
  if (!query) return true;
  return `${option.label} ${option.hint ?? ''}`.toLowerCase().includes(query);
}

/**
 * Renders the searchable dropdown.
 *
 * @param props - See {@link SearchableSelectProps}.
 */
export function SearchableSelect({
  id,
  options,
  value,
  onValueChange,
  placeholder,
  searchPlaceholder,
  emptyText,
}: Readonly<SearchableSelectProps>) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const listId = `${id}-list`;
  const q = query.trim().toLowerCase();
  const shown = options.filter((o) => matches(o, q));
  const selected = options.find((o) => o.value === value);

  function openChange(next: boolean) {
    setOpen(next);
    if (next) {
      setQuery('');
      setActive(
        Math.max(
          0,
          options.findIndex((o) => o.value === value),
        ),
      );
    }
  }

  function pick(option: SearchableOption) {
    onValueChange(option.value);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const option = shown[active];
      if (option) pick(option);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={openChange}>
      <Popover.Trigger asChild>
        <button
          id={id}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          className={cn(
            'flex w-full items-center justify-between gap-2 rounded-[10px] border border-(--bd-border) bg-(--bd-bg) px-3 py-2.5 text-left text-[14px] text-(--bd-fg) transition-colors',
            'hover:bg-(--bd-border-soft) focus:outline-hidden focus-visible:border-(--bd-primary) focus-visible:bg-(--bd-card) focus-visible:ring-4 focus-visible:ring-(--bd-primary-50)',
          )}
        >
          <span className={cn('line-clamp-1', !selected && 'text-(--bd-fg-muted)')}>
            {selected?.hint
              ? `${selected.label} (${selected.hint})`
              : (selected?.label ?? placeholder)}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="z-50 w-(--radix-popover-trigger-width) overflow-hidden rounded-[10px] border border-(--bd-border) bg-(--bd-card) text-(--bd-fg) shadow-lg"
        >
          <div className="flex items-center gap-2 border-b border-(--bd-border-soft) px-3 py-2">
            <Search className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
            <input
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
              aria-label={searchPlaceholder}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-(--bd-fg-muted)"
            />
          </div>
          <ul id={listId} role="listbox" className="max-h-72 overflow-y-auto p-1">
            {shown.length === 0 ? (
              <li className="px-3 py-2.5 text-[13px] text-(--bd-fg-muted)">{emptyText}</li>
            ) : (
              shown.map((o, i) => (
                <li
                  key={o.value}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o)}
                  // Keys are handled on the search box (aria-activedescendant); this keeps
                  // an option usable if focus ever lands on it.
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') pick(o);
                  }}
                  className={cn(
                    'relative flex cursor-pointer items-center gap-3 rounded-[8px] py-2 pr-2 pl-8 text-[14px]',
                    i === active && 'bg-(--bd-primary-50) text-(--bd-primary-600)',
                    o.value === value && 'font-semibold',
                  )}
                >
                  {o.value === value ? (
                    <Check
                      className="absolute left-2 h-4 w-4 text-(--bd-primary)"
                      aria-hidden="true"
                    />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.hint ? (
                    <span className="shrink-0 text-[12.5px] text-(--bd-fg-muted)">{o.hint}</span>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
