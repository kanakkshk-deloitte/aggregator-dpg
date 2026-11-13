/**
 * Base Data Transfer Object types shared across aggregator-dpg services.
 *
 * These types represent common pagination, filtering, and timestamp
 * structures used at service boundaries.
 *
 * @module @aggregator-dpg/shared-primitives/dto
 */

import { z } from 'zod';

/** Common audit timestamps added to every persisted entity. */
export interface Timestamps {
  createdAt: Date;
  updatedAt: Date;
}

/** Zod schema for Timestamps — parses ISO string or Date to Date. */
export const TimestampsSchema = z.object({
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/** Opaque cursor for keyset pagination. */
export interface Cursor {
  /** Base64url-encoded opaque value — callers must not parse this. */
  value: string;
}

/** Zod schema for Cursor. */
export const CursorSchema = z.object({
  value: z.string().min(1),
});

/**
 * Wraps a page of items with pagination metadata.
 *
 * @typeParam T - The item type contained in this page.
 */
export interface Paginated<T> {
  items: T[];
  total: number;
  /** Present when a next page exists; absent on the last page. */
  nextCursor?: Cursor;
}

/**
 * Builds a Zod schema for Paginated<T> given a schema for item T.
 *
 * @param itemSchema - Zod schema for a single item.
 * @returns Zod schema for Paginated<T>.
 */
export function paginatedSchema<T>(itemSchema: z.ZodType<T>) {
  return z.object({
    items: z.array(itemSchema),
    total: z.number().int().nonnegative(),
    nextCursor: CursorSchema.optional(),
  });
}

/** Sort direction for list queries. */
export type SortDirection = 'asc' | 'desc';

/** SortDirection Zod schema. */
export const SortDirectionSchema = z.enum(['asc', 'desc']);

/**
 * Common filter parameters for list endpoints.
 *
 * Services extend this with domain-specific fields.
 */
export interface Filter {
  /** Maximum number of items to return. */
  limit?: number;
  /** Opaque cursor value from a previous response. */
  cursor?: string;
  sortDirection?: SortDirection;
}

/** Zod schema for Filter. */
export const FilterSchema = z.object({
  limit: z.number().int().positive().max(1000).optional(),
  cursor: z.string().optional(),
  sortDirection: SortDirectionSchema.optional(),
});

/**
 * Builds the `fields` query parameter of a read that returns some data only on request.
 *
 * The value is a comma-separated list of names from `allowed`, with no spaces.
 * A name may contain dots, as in `parent.known_as_values`; they match only a dot.
 * An absent or empty value requests nothing extra. Any other name fails validation.
 *
 * @param allowed - The names the read accepts.
 * @returns A schema that parses the value to the requested names, without repeats.
 */
export function fieldsQuerySchema<const T extends readonly [string, ...string[]]>(allowed: T) {
  const name = allowed.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = new RegExp(`^(?:(?:${name})(?:,(?:${name}))*)?$`);
  return z
    .string()
    .regex(pattern, { message: `fields takes a comma-separated list of: ${allowed.join(', ')}` })
    .optional()
    .describe(`Comma-separated list of extra data to include: ${allowed.join(', ')}.`)
    .transform((v): Array<T[number]> => (v ? [...new Set(v.split(','))] : []));
}
