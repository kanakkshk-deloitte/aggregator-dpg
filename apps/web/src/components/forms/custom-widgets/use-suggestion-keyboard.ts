/**
 * Keyboard navigation for the autocomplete widgets' suggestion lists.
 *
 * Shared by the location, multi-location, and reference widgets.
 *
 * Screen readers announce the active option through `aria-activedescendant`,
 * which must point at a `role="option"` inside a `role="listbox"`.
 *
 * Same as Signals-DPG
 * `apps/ui/src/components/forms/custom-widgets/use-suggestion-keyboard.ts`.
 *
 * @module apps/web/components/forms/custom-widgets/use-suggestion-keyboard
 */
import * as React from 'react';

interface UseSuggestionKeyboardArgs {
  /**
   * The suggestions currently listed, in display order.
   *
   * The highlight resets when this array changes. Pass a stable array (from
   * `useState` or `useMemo`), or the highlight clears on every render.
   */
  items: readonly unknown[];
  /** Whether the list is showing. */
  open: boolean;
  /** Opens the list (ArrowDown/ArrowUp on a closed list). */
  onOpen: () => void;
  /** Closes the list (Escape or Tab). */
  onClose: () => void;
  /** Selects the suggestion at `index` (Enter). */
  onSelect: (index: number) => void;
  /** Stable prefix for the generated option ids; must be unique per field. */
  idPrefix: string;
}

interface UseSuggestionKeyboardResult {
  /** Index of the option the keyboard is on, or -1 for none. */
  activeIndex: number;
  /** Called on hover so mouse and keyboard share one highlight. */
  setActiveIndex: (index: number) => void;
  /** The DOM id for option `index`, for the option element itself. */
  optionId: (index: number) => string;
  /**
   * Value for the input's `aria-activedescendant`.
   *
   * `undefined` when nothing is active or the list is closed (and unmounted).
   */
  activeDescendantId: string | undefined;
  /** The listbox's own id, for the input's `aria-controls`. */
  listboxId: string;
  /** Attach to the text input. */
  onKeyDown: (event: React.KeyboardEvent) => void;
}

export function useSuggestionKeyboard({
  items,
  open,
  onOpen,
  onClose,
  onSelect,
  idPrefix,
}: UseSuggestionKeyboardArgs): UseSuggestionKeyboardResult {
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const count = items.length;

  const listboxId = `${idPrefix}-listbox`;
  const optionId = React.useCallback((index: number) => `${idPrefix}-option-${index}`, [idPrefix]);

  // New results start with no active option. Keyed on `items`, not on `count`
  // (same-size results would keep a stale index) or `open` (opening by
  // keypress would clear the index it just set).
  React.useEffect(() => {
    setActiveIndex(-1);
  }, [items]);

  // Keep the highlighted option scrolled into view.
  React.useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, optionId]);

  // On a closed list, ArrowDown opens at the top and ArrowUp at the bottom.
  const handleClosedKey = React.useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      onOpen();
      setActiveIndex(event.key === 'ArrowDown' ? 0 : count - 1);
    },
    [count, onOpen],
  );

  const handleOpenKey = React.useCallback(
    (event: React.KeyboardEvent): void => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          // Stops at the last option; does not wrap.
          setActiveIndex((i) => Math.min(i + 1, count - 1));
          return;

        case 'ArrowUp':
          event.preventDefault();
          // With nothing active, ArrowUp goes to the last option.
          setActiveIndex((i) => (i < 0 ? count - 1 : Math.max(i - 1, 0)));
          return;

        case 'Home':
          event.preventDefault();
          setActiveIndex(0);
          return;

        case 'End':
          event.preventDefault();
          setActiveIndex(count - 1);
          return;

        case 'Enter':
          // With no active option, Enter falls through and submits the form.
          if (activeIndex < 0) return;
          event.preventDefault();
          onSelect(activeIndex);
          return;

        case 'Escape':
          event.preventDefault();
          onClose();
          setActiveIndex(-1);
          return;

        case 'Tab':
          // Not prevented: focus moves on and the list closes.
          onClose();
          return;

        default:
          return;
      }
    },
    [count, activeIndex, onClose, onSelect],
  );

  const onKeyDown = React.useCallback(
    (event: React.KeyboardEvent) => {
      if (count === 0) return;
      if (open) handleOpenKey(event);
      else handleClosedKey(event);
    },
    [count, open, handleOpenKey, handleClosedKey],
  );

  return {
    activeIndex,
    setActiveIndex,
    optionId,
    activeDescendantId: open && activeIndex >= 0 ? optionId(activeIndex) : undefined,
    listboxId,
    onKeyDown,
  };
}
