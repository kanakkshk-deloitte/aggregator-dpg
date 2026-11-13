import Image from 'next/image';
import { useThemeMode } from '../../lib/theme-mode';
import type { JSX } from 'react';
import type { BrandAttribution as Row } from '../../hooks/useAggregatorConfig';

/**
 * "Owned by <X> / Managed by <Y>" rows.
 *
 * Rendered on the right pane, which shows at every width (`BrandPanel` is
 * hidden below `lg`). Uses the purple marks because the pane is white.
 *
 * Renders nothing when the brand declares no rows.
 */
// `rows: Row[] | undefined` (not `rows?:`) so callers can pass `undefined`
// under `exactOptionalPropertyTypes`.
export function BrandAttribution({
  rows,
}: Readonly<{ rows: Row[] | undefined }>): JSX.Element | null {
  // `logoLight` is the dark-mode variant. A mark that works on both
  // backgrounds sets only `logo`.
  const { mode } = useThemeMode();
  if (!rows?.length) return null;
  return (
    // Marks are sized by height only, so each column is as wide as its mark
    // and `items-center` centres the caption over the logo. The block is
    // centred with `justify-center` so it works for any mark widths.
    <div className="mt-16 flex w-full items-start justify-center gap-8">
      {rows.map((row) => (
        <div key={`${row.label}-${row.name}`} className="flex flex-col items-center gap-2">
          <span className="text-xs font-medium tracking-wide text-ink-400">{row.label}</span>
          {row.logo ? (
            <Image
              src={(mode === 'dark' ? (row.logoLight ?? row.logo) : row.logo) as string}
              alt={row.name}
              width={352}
              height={160}
              className="h-24 w-auto object-contain object-center"
            />
          ) : (
            <span className="text-sm font-semibold text-ink-900">{row.name}</span>
          )}
        </div>
      ))}
    </div>
  );
}
