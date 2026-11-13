/**
 * Edge middleware test: stamps `x-pathname` for downstream layouts.
 *
 * `middleware.ts` is intentionally minimal (Edge runtime, no Redis) — the
 * only behaviour worth asserting is that it derives `x-pathname` (path +
 * search) from the request and forwards the request unmodified otherwise.
 */
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, config } from '../../../../middleware';

describe('middleware', () => {
  it('stamps x-pathname with the pathname for a plain path', () => {
    const req = new NextRequest('http://localhost/dashboard');
    const res = middleware(req);
    expect(res.headers.get('x-pathname')).toBe('/dashboard');
  });

  it('stamps x-pathname including the query string', () => {
    const req = new NextRequest('http://localhost/links?status=live&limit=10');
    const res = middleware(req);
    expect(res.headers.get('x-pathname')).toBe('/links?status=live&limit=10');
  });

  it('stamps x-pathname for a nested route', () => {
    const req = new NextRequest('http://localhost/api/dashboard/export');
    const res = middleware(req);
    expect(res.headers.get('x-pathname')).toBe('/api/dashboard/export');
  });

  it('stamps x-pathname for the root path', () => {
    const req = new NextRequest('http://localhost/');
    const res = middleware(req);
    expect(res.headers.get('x-pathname')).toBe('/');
  });

  it('exports a matcher config excluding _next static/image and favicon', () => {
    expect(config.matcher).toEqual(['/((?!_next/static|_next/image|favicon.ico).*)']);
  });
});
