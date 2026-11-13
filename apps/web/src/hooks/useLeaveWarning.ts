'use client';

import { useEffect } from 'react';

/**
 * Asks the browser to confirm before the page is reloaded or closed while
 * `active` is true, so unsent work is not lost by accident.
 *
 * The browser shows its own wording; a custom message is ignored. Navigation
 * inside the app (Next.js links) does not unload the page and is not covered.
 *
 * @param active - Whether there is unsent work on the page.
 */
export function useLeaveWarning(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active]);
}
