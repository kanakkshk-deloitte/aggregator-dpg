/**
 * Dashboard tile resolution for the web app.
 *
 * Maps tile definitions onto precomputed rollup fields; the dashboard does no aggregation.
 *
 * @module apps/web/services/tiles
 */

/** Structural shape of a tile definition (mirrors `DashboardTileDef`). */
export interface TileDef {
  field: string;
  label: string;
}

/** A tile def joined with its numeric value read from the rollup. */
export interface ResolvedTile {
  field: string;
  label: string;
  value: number;
}

/**
 * Resolves tile defs (or the defaults) and reads each value from the rollup by `field`.
 *
 * While the rollup is loading, every tile has value 0. A tile whose field is
 * missing or not a number is skipped with a console warning.
 *
 * @param defs - Config-sourced tile defs for this group, or undefined.
 * @param fallback - Default tiles to use when `defs` is empty/undefined.
 * @param rollup - The domain rollup to read values from.
 * @returns Tiles safe to render, in definition order.
 */
export function resolveTiles(
  defs: TileDef[] | undefined,
  fallback: TileDef[],
  rollup: object | undefined,
): ResolvedTile[] {
  const source = defs && defs.length ? defs : fallback;
  if (!rollup) {
    return source.map((d) => ({ field: d.field, label: d.label, value: 0 }));
  }
  // Every read below is type-checked at runtime.
  const byField = rollup as Record<string, unknown>;
  const out: ResolvedTile[] = [];
  for (const d of source) {
    const v = byField[d.field];
    if (typeof v !== 'number') {
      console.warn(
        `dashboard tile "${d.field}" skipped — rollup field is ${v === undefined ? 'missing' : 'not numeric'}`,
      );
      continue;
    }
    out.push({ field: d.field, label: d.label, value: v });
  }
  return out;
}
