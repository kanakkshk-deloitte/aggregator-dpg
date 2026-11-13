import { describe, it, expect } from 'vitest';
import { unauthorizedResponse, serviceUnavailableResponse } from '@/lib/bff-errors';

describe('unauthorizedResponse', () => {
  it('returns a 401 with the stable NO_ACTIVE_SESSION code', async () => {
    const res = unauthorizedResponse();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe('Unauthorized');
    expect(body.code).toBe('NO_ACTIVE_SESSION');
  });
});

describe('serviceUnavailableResponse', () => {
  it('returns a 503 with an uppercased, underscored code and default detail', async () => {
    const res = serviceUnavailableResponse('aggregator-api');
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: string;
      code: string;
      message: string;
      detail: string;
    };
    expect(body.error).toBe('ServiceUnavailable');
    expect(body.code).toBe('AGGREGATOR_API_UPSTREAM_FAILED');
    expect(body.message).toContain('aggregator-api');
    expect(body.detail).toBe('unknown error');
  });

  it('carries a custom detail string through untouched', async () => {
    const res = serviceUnavailableResponse('keycloak', 'connect ECONNREFUSED');
    const body = (await res.json()) as { detail: string; code: string };
    expect(body.detail).toBe('connect ECONNREFUSED');
    expect(body.code).toBe('KEYCLOAK_UPSTREAM_FAILED');
  });
});
