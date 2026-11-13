/**
 * Session cache for geo lookups. Same as Signals-DPG `apps/ui/src/lib/geo/geo-cache.ts`.
 *
 * @module apps/web/lib/geo/geo-cache
 */
import type { GeoProvider, GeoSuggestion } from './types';

/** Default LRU cap for a memoized geo lookup (entries). */
const DEFAULT_CACHE_CAP = 500;

/**
 * Normalises a place query (trim, lowercase, single spaces) for use as a cache key.
 *
 * @param query - The raw query.
 * @returns The normalised key.
 */
export function normalizeGeoKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Wraps an async geo lookup with a session LRU cache and in-flight dedup.
 *
 * Only results where `shouldCache(value)` is true are stored. The shared call
 * is aborted only when every waiting caller has aborted.
 *
 * @param fn - The lookup to wrap.
 * @param shouldCache - Whether a result may be cached.
 * @param cap - Maximum cache entries.
 * @returns The memoised lookup.
 */
export function memoizeGeoLookup<T>(
  fn: (query: string, signal?: AbortSignal) => Promise<T>,
  shouldCache: (value: T) => boolean,
  cap: number = DEFAULT_CACHE_CAP,
): (query: string, signal?: AbortSignal) => Promise<T> {
  const resolved = new Map<string, T>();

  interface InFlight {
    promise: Promise<T>;
    controller: AbortController;
    waiters: Set<object>;
  }
  const inFlight = new Map<string, InFlight>();

  return (query: string, signal?: AbortSignal): Promise<T> => {
    const key = normalizeGeoKey(query);

    if (resolved.has(key)) {
      const value = resolved.get(key)!;
      resolved.delete(key); // refresh LRU recency
      resolved.set(key, value);
      return Promise.resolve(value);
    }

    let entry = inFlight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: InFlight = {
        controller,
        waiters: new Set<object>(),
        promise: fn(query, controller.signal)
          .then((value) => {
            if (shouldCache(value)) {
              resolved.set(key, value);
              if (resolved.size > cap) {
                const oldest = resolved.keys().next().value as string;
                resolved.delete(oldest);
              }
            }
            return value;
          })
          .finally(() => {
            inFlight.delete(key);
          }),
      };
      inFlight.set(key, created);
      entry = created;
    }

    // Abort the shared fetch only when every waiter has aborted.
    const current = entry;
    const token = {};
    current.waiters.add(token);

    if (signal) {
      const onAbort = () => {
        current.waiters.delete(token);
        if (current.waiters.size === 0) current.controller.abort();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        void current.promise.finally(() => signal.removeEventListener('abort', onAbort));
      }
    }
    void current.promise.finally(() => {
      current.waiters.delete(token);
    });

    return current.promise;
  };
}

/**
 * Wraps a GeoProvider so `suggest` results are session-cached when non-empty.
 *
 * @param base - The provider to wrap.
 * @returns The cached provider.
 */
export function withGeoCache(base: GeoProvider): GeoProvider {
  const cachedSuggest = memoizeGeoLookup<GeoSuggestion[]>(
    (q, signal) => base.suggest(q, signal),
    (results) => results.length > 0,
  );
  return { suggest: cachedSuggest };
}
