'use client';

/**
 * Multi-select popover for array-of-enum form fields. A Radix Popover trigger
 * styled like `bd-input` opens a checkbox list. Selected values show as chips
 * on the trigger; a chip's × removes it.
 */

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, ChevronDown, X } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface MultiSelectOption {
  value: string;
  label: string;
}

export interface MultiSelectProps {
  id?: string;
  options: MultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
}

/**
 * Toggles `option` in `selected`. New values are appended, so chip order
 * follows the order the user picked them.
 */
function toggle(selected: string[], option: string): string[] {
  return selected.includes(option) ? selected.filter((v) => v !== option) : [...selected, option];
}

export function MultiSelect({
  id,
  options,
  value,
  onChange,
  placeholder = 'Select options…',
  disabled,
  required: _required,
  className,
}: MultiSelectProps) {
  const [open, setOpen] = React.useState(false);
  const selectedSet = React.useMemo(() => new Set(value), [value]);

  const labelFor = React.useCallback(
    (v: string) => options.find((o) => o.value === v)?.label ?? v,
    [options],
  );

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          aria-haspopup="listbox"
          className={cn(
            'flex min-h-[42px] w-full flex-wrap items-center gap-1.5 rounded-[10px] border border-(--bd-border) bg-(--bd-bg) px-3 py-2 text-left text-[14px] text-(--bd-fg) transition-colors',
            'hover:bg-(--bd-border-soft) focus:outline-hidden focus-visible:border-(--bd-primary) focus-visible:bg-(--bd-card) focus-visible:ring-4 focus-visible:ring-(--bd-primary-50)',
            'disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
        >
          {value.length === 0 ? (
            <span className="text-(--bd-fg-muted)">{placeholder}</span>
          ) : (
            value.map((v) => (
              <span
                key={v}
                className="inline-flex items-center gap-1 rounded-full bg-(--bd-primary-50) px-2 py-0.5 text-[12px] font-medium text-(--bd-primary-600)"
              >
                {labelFor(v)}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onChange(value.filter((x) => x !== v));
                  }}
                  className="rounded-full p-0.5 hover:bg-(--bd-primary-100)"
                  aria-label={`Remove ${labelFor(v)}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))
          )}
          <ChevronDown className="ml-auto h-4 w-4 shrink-0 opacity-60" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={4}
          className="z-50 max-h-[280px] w-(--radix-popover-trigger-width) overflow-y-auto rounded-[10px] border border-(--bd-border) bg-(--bd-card) p-1 shadow-lg"
        >
          {options.length === 0 ? (
            <div className="px-3 py-2 text-[13px] text-(--bd-fg-muted)">No options.</div>
          ) : (
            options.map((opt) => {
              const checked = selectedSet.has(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onChange(toggle(value, opt.value))}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-[8px] px-2 py-2 text-left text-[14px] outline-hidden transition-colors',
                    'hover:bg-(--bd-primary-50) focus-visible:bg-(--bd-primary-50) focus-visible:text-(--bd-primary-600)',
                    checked && 'font-semibold text-(--bd-primary-600)',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded-sm border',
                      checked
                        ? 'border-(--bd-primary) bg-(--bd-primary) text-white'
                        : 'border-(--bd-border) bg-(--bd-card)',
                    )}
                    aria-hidden
                  >
                    {checked && <Check className="h-3 w-3" />}
                  </span>
                  {opt.label}
                </button>
              );
            })
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
