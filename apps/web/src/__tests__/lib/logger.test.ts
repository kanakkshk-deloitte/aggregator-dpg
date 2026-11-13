import { describe, it, expect, vi, afterEach } from 'vitest';

describe('logger module init', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.resetModules();
  });

  it('builds a pino instance in production mode (no pretty-print transport)', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    const { logger } = await import('@/lib/logger');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });

  it('builds a pino instance in dev mode (pretty-print transport)', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'development';
    const { logger } = await import('@/lib/logger');
    expect(logger).toBeDefined();
  });
});

describe('pickRequestId', () => {
  it('reuses a valid inbound x-request-id header', async () => {
    const { pickRequestId } = await import('@/lib/logger');
    const headers = new Headers({ 'x-request-id': 'req-inbound-1' });
    expect(pickRequestId(headers)).toBe('req-inbound-1');
  });

  it('mints a fresh id when the header is absent', async () => {
    const { pickRequestId } = await import('@/lib/logger');
    const headers = new Headers();
    expect(pickRequestId(headers)).toMatch(/^req-/);
  });

  it('mints a fresh id when the header is implausibly long', async () => {
    const { pickRequestId } = await import('@/lib/logger');
    const headers = new Headers({ 'x-request-id': 'x'.repeat(200) });
    expect(pickRequestId(headers)).toMatch(/^req-/);
  });

  it('mints a fresh id when the header is empty', async () => {
    const { pickRequestId } = await import('@/lib/logger');
    const headers = new Headers({ 'x-request-id': '' });
    expect(pickRequestId(headers)).toMatch(/^req-/);
  });
});
