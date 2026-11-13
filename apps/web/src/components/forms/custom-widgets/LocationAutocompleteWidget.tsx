'use client';

/**
 * Address autocomplete for a single `location`-marked schema field.
 *
 * Matches the Signals-DPG location widget, with two differences:
 *
 *  1. The form context is read from `registry.formContext`. The `formContext`
 *     prop type-checks but is always `undefined` in RJSF v6.
 *  2. Errors are rendered by `FieldTemplate`, not by this widget.
 *
 * @module apps/web/components/forms/custom-widgets/LocationAutocompleteWidget
 */

import * as React from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { useTranslations } from 'next-intl';
import { Input } from '../../ui/Input';
import { Search } from 'lucide-react';
import { cn } from '../../../lib/cn';
import { getGeoProvider } from '../../../lib/geo/provider';
import { useFormRuntimeConfig } from '../../../lib/FormRuntimeConfigProvider';
import { useSuggestionKeyboard } from './use-suggestion-keyboard';
import type { GeoComponents, GeoSuggestion } from '../../../lib/geo/types';

/**
 * A selected place reported to the page.
 *
 * `components` keeps the shape compatible with Signals but is not read. The
 * exact point is submitted; Signals handles any coarsening.
 */
export interface ResolvedPlace {
  lat: number;
  lng: number;
  components?: GeoComponents;
}

export interface LocationFormContext {
  onLocationResolved?: (place: ResolvedPlace | null) => void;
}

/** How close to the viewport bottom the input may sit before the list flips up. */
const DROP_UP_THRESHOLD_PX = 260;
/** Shortest query worth sending to a geocoder. */
const MIN_QUERY_LENGTH = 3;
const DEBOUNCE_MS = 300;
/** Long enough for a suggestion's mousedown to land before blur closes the list. */
const BLUR_CLOSE_MS = 150;

export function LocationAutocompleteWidget({
  id,
  value,
  disabled,
  readonly,
  onChange,
  placeholder,
  registry,
  options,
}: Readonly<WidgetProps>) {
  const t = useTranslations('form');
  const ctx = (registry?.formContext ?? {}) as LocationFormContext;
  const isPrimary =
    (options as { isPrimaryLocation?: boolean } | undefined)?.isPrimaryLocation === true;

  const [text, setText] = React.useState<string>((value as string) ?? '');
  const [suggestions, setSuggestions] = React.useState<GeoSuggestion[]>([]);
  const [open, setOpen] = React.useState(false);
  // Open the list upward when the input is near the viewport bottom.
  const [dropUp, setDropUp] = React.useState(false);

  const inputRef = React.useRef<HTMLInputElement>(null);
  const debounceRef = React.useRef<number | undefined>(undefined);
  const blurRef = React.useRef<number | undefined>(undefined);
  const abortRef = React.useRef<AbortController | null>(null);

  const config = useFormRuntimeConfig();
  const provider = React.useMemo(
    () =>
      getGeoProvider({
        ...(config.googleMapsApiKey ? { googleMapsApiKey: config.googleMapsApiKey } : {}),
        ...(config.photonUrl ? { photonUrl: config.photonUrl } : {}),
        ...(config.geoCountry ? { country: config.geoCountry } : {}),
      }),
    [config.googleMapsApiKey, config.photonUrl, config.geoCountry],
  );

  // Sync the text with new values from RJSF. Does not search; only typing
  // searches, so choosing a suggestion never re-opens the list.
  React.useEffect(() => {
    setText((value as string) ?? '');
  }, [value]);

  // Cancel any pending work on unmount.
  React.useEffect(
    () => () => {
      window.clearTimeout(debounceRef.current);
      window.clearTimeout(blurRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  function runSearch(query: string) {
    window.clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    const q = query.trim();
    if (q.length < MIN_QUERY_LENGTH) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;
      void provider.suggest(q, controller.signal).then((results) => {
        if (controller.signal.aborted) return;
        setSuggestions(results);
        setOpen(results.length > 0);
        if (results.length > 0) {
          const rect = inputRef.current?.getBoundingClientRect();
          setDropUp(!!rect && window.innerHeight - rect.bottom < DROP_UP_THRESHOLD_PX);
        }
      });
    }, DEBOUNCE_MS);
  }

  function handleInput(next: string) {
    setText(next);
    // `undefined`, not '', so a cleared required field fails validation.
    onChange(next === '' ? undefined : next);
    // Typed text is not a resolved place, so drop any earlier coordinate.
    if (isPrimary) ctx.onLocationResolved?.(null);
    runSearch(next);
  }

  function choose(suggestion: GeoSuggestion) {
    // Cancel pending/in-flight work so choosing never re-opens the list.
    window.clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    setText(suggestion.label);
    onChange(suggestion.label);
    setSuggestions([]);
    setOpen(false);
    // Only the primary field's coordinate is saved, as in Signals.
    if (isPrimary) {
      ctx.onLocationResolved?.({
        lat: suggestion.lat,
        lng: suggestion.lng,
        ...(suggestion.components ? { components: suggestion.components } : {}),
      });
    }
  }

  const { activeIndex, setActiveIndex, optionId, activeDescendantId, listboxId, onKeyDown } =
    useSuggestionKeyboard({
      items: suggestions,
      open,
      onOpen: () => setOpen(true),
      onClose: () => setOpen(false),
      onSelect: (index) => {
        const suggestion = suggestions[index];
        if (suggestion) choose(suggestion);
      },
      idPrefix: id,
    });

  return (
    <div className="relative">
      {/* Search icon so the field reads as a search box. Decorative only. */}
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-(--bd-muted)"
      />
      <Input
        ref={inputRef}
        className="bd-input--icon-left"
        id={id}
        value={text}
        disabled={Boolean(disabled || readonly)}
        autoComplete="off"
        placeholder={placeholder || t('location_search_placeholder')}
        role="combobox"
        aria-expanded={open && suggestions.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeDescendantId}
        onChange={(e) => handleInput(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(suggestions.length > 0)}
        onBlur={() => {
          // Delay the close so a suggestion's mousedown still registers.
          blurRef.current = window.setTimeout(() => setOpen(false), BLUR_CLOSE_MS);
        }}
      />
      {open && suggestions.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className={cn(
            'absolute left-0 z-50 max-h-[280px] w-full overflow-y-auto rounded-[10px] border border-(--bd-border) bg-(--bd-card) p-1 shadow-lg',
            dropUp ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          {suggestions.map((s, i) => (
            // `role="option"` so `aria-activedescendant` can point at it.
            <li
              key={`${s.lat},${s.lng},${i}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              className={cn(
                'cursor-pointer rounded-[8px] px-2 py-2 text-[14px] transition-colors',
                i === activeIndex
                  ? 'bg-(--bd-primary-50) text-(--bd-primary-600)'
                  : 'hover:bg-(--bd-primary-50)',
              )}
              // onMouseDown runs before the input's blur; preventDefault keeps focus.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(s);
              }}
              // Hover moves the keyboard highlight too.
              onMouseEnter={() => setActiveIndex(i)}
            >
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
