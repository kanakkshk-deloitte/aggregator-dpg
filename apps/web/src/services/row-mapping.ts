import type { DirectionalStats } from '../types';

/**
 * Converts a dashboard item's `initiated` or `received` map into {@link DirectionalStats}.
 *
 * Missing buckets become 0.
 *
 * @param raw - The directional map from a dashboard item, or undefined.
 * @returns A fully-populated directional stats object.
 */
export function mapDirectional(raw: unknown): DirectionalStats {
  const m = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    create: num(m.create),
    accept: num(m.accept),
    reject: num(m.reject),
    cancel: num(m.cancel),
  };
}
