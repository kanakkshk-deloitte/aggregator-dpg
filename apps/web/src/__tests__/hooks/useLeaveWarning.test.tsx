/**
 * Unit tests for useLeaveWarning: the reload/close prompt is armed only while
 * there is unsent work, and released when the work is gone or on unmount.
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useLeaveWarning } from '@/hooks/useLeaveWarning';

/** Dispatches a cancelable beforeunload and reports whether it was blocked. */
function unloadBlocked(): boolean {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

describe('useLeaveWarning', () => {
  it('blocks unload while active', () => {
    renderHook(() => useLeaveWarning(true));
    expect(unloadBlocked()).toBe(true);
  });

  it('does nothing while inactive', () => {
    renderHook(() => useLeaveWarning(false));
    expect(unloadBlocked()).toBe(false);
  });

  it('releases the prompt when work is gone and on unmount', () => {
    const { rerender, unmount } = renderHook(({ on }) => useLeaveWarning(on), {
      initialProps: { on: true },
    });
    rerender({ on: false });
    expect(unloadBlocked()).toBe(false);
    rerender({ on: true });
    unmount();
    expect(unloadBlocked()).toBe(false);
  });
});
