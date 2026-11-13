import { describe, it, expect } from 'vitest';
import {
  TimestampsSchema,
  CursorSchema,
  paginatedSchema,
  FilterSchema,
  SortDirectionSchema,
  fieldsQuerySchema,
} from '../dto/index.js';
import { z } from 'zod';

describe('TimestampsSchema', () => {
  it('parses ISO date strings', () => {
    const ts = TimestampsSchema.parse({
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-06-15T12:00:00Z',
    });
    expect(ts.createdAt).toBeInstanceOf(Date);
    expect(ts.updatedAt).toBeInstanceOf(Date);
  });

  it('passes through Date objects', () => {
    const now = new Date();
    const ts = TimestampsSchema.parse({ createdAt: now, updatedAt: now });
    expect(ts.createdAt.getTime()).toBe(now.getTime());
  });

  it('rejects invalid dates', () => {
    expect(() => TimestampsSchema.parse({ createdAt: 'not-a-date', updatedAt: '2024' })).toThrow();
  });
});

describe('CursorSchema', () => {
  it('parses valid cursor', () => {
    const c = CursorSchema.parse({ value: 'abc123' });
    expect(c.value).toBe('abc123');
  });

  it('rejects empty cursor value', () => {
    expect(() => CursorSchema.parse({ value: '' })).toThrow();
  });
});

describe('paginatedSchema', () => {
  const itemSchema = z.object({ id: z.string() });
  const schema = paginatedSchema(itemSchema);

  it('parses page with items and total', () => {
    const page = schema.parse({ items: [{ id: '1' }], total: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.nextCursor).toBeUndefined();
  });

  it('parses page with nextCursor', () => {
    const page = schema.parse({
      items: [],
      total: 100,
      nextCursor: { value: 'cursor-xyz' },
    });
    expect(page.nextCursor?.value).toBe('cursor-xyz');
  });

  it('rejects negative total', () => {
    expect(() => schema.parse({ items: [], total: -1 })).toThrow();
  });

  it('handles empty items array', () => {
    const page = schema.parse({ items: [], total: 0 });
    expect(page.items).toHaveLength(0);
  });
});

describe('FilterSchema', () => {
  it('parses empty filter', () => {
    const f = FilterSchema.parse({});
    expect(f.limit).toBeUndefined();
    expect(f.cursor).toBeUndefined();
  });

  it('parses limit and sortDirection', () => {
    const f = FilterSchema.parse({ limit: 20, sortDirection: 'desc' });
    expect(f.limit).toBe(20);
    expect(f.sortDirection).toBe('desc');
  });

  it('rejects limit of zero', () => {
    expect(() => FilterSchema.parse({ limit: 0 })).toThrow();
  });

  it('rejects limit over 1000', () => {
    expect(() => FilterSchema.parse({ limit: 1001 })).toThrow();
  });
});

describe('SortDirectionSchema', () => {
  it('accepts asc and desc', () => {
    expect(SortDirectionSchema.parse('asc')).toBe('asc');
    expect(SortDirectionSchema.parse('desc')).toBe('desc');
  });

  it('rejects invalid direction', () => {
    expect(() => SortDirectionSchema.parse('DESC')).toThrow();
  });
});

describe('fieldsQuerySchema', () => {
  const fields = fieldsQuerySchema(['a_b', 'c']);

  it('parses a comma-separated list without repeats', () => {
    expect(fields.parse('a_b')).toEqual(['a_b']);
    expect(fields.parse('c,a_b,c')).toEqual(['c', 'a_b']);
  });

  it('treats an absent or empty value as nothing requested', () => {
    expect(fields.parse(undefined)).toEqual([]);
    expect(fields.parse('')).toEqual([]);
  });

  it('refuses unknown names, spaces and empty entries', () => {
    for (const bad of ['d', 'a_b,d', 'a_b, c', ',c', 'c,', 'a', 'a_bc']) {
      expect(fields.safeParse(bad).success).toBe(false);
    }
  });
});
