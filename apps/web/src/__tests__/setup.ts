import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import type * as NextNavigationModule from 'next/navigation';

afterEach(() => {
  cleanup();
});

if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }
  if (!window.ResizeObserver) {
    Object.defineProperty(window, 'ResizeObserver', {
      writable: true,
      // Must be a `function`, not an arrow: this is invoked as
      // `new ResizeObserver(...)`, and vitest 4 propagates the real
      // "is not a constructor" TypeError instead of papering over it.
      value: vi.fn(function () {
        return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
      }),
    });
  }
  // jsdom 25 on Node >=22 defers `window.localStorage` to Node's own
  // experimental global Storage, which refuses to activate without a
  // `--localstorage-file` flag and leaves the property `undefined`. Shim a
  // plain in-memory Storage so code under test (e.g. `lib/theme-mode.tsx`)
  // can read/write it like a real browser would.
  if (!window.localStorage) {
    const store = new Map<string, string>();
    const memoryStorage: Storage = {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      writable: true,
      value: memoryStorage,
    });
  }
}

// jsdom implements no layout, so it ships no `scrollIntoView` at all — calling
// it throws rather than no-oping. The autocomplete widgets call it to keep the
// arrow-key-highlighted option in view, which is real behaviour worth keeping;
// without this shim any keyboard-navigation test dies inside a React effect,
// where the failure surfaces as an unrelated-looking commit-phase TypeError.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
}

if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = vi.fn().mockImplementation(() => ({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    createRadialGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
  }));
}

vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof NextNavigationModule>('next/navigation');
  return {
    ...actual,
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    }),
    usePathname: () => '/',
    useSearchParams: () => new URLSearchParams(),
  };
});
