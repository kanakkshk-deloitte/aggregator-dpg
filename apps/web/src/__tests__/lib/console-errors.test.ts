import { describe, expect, it } from 'vitest';
import { plainErrorKey } from '@/lib/console-errors';

const fail = (status: number, code?: string) => ({ status, error: code ? { code } : {} });

describe('plainErrorKey', () => {
  it.each([
    [0, 'network'],
    [401, 'signed_out'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'server'],
    [503, 'server'],
    [400, 'generic'],
    [409, 'generic'],
  ])('maps %i to %s', (status, kind) => {
    expect(plainErrorKey(fail(status), 'orgs')).toBe(`orgs.error.${kind}`);
  });

  it('prefers a kind named for the error code', () => {
    expect(
      plainErrorKey(fail(409, 'TARGET_ORG_INACTIVE'), 'coordinator', {
        TARGET_ORG_INACTIVE: 'org_inactive',
      }),
    ).toBe('coordinator.error.org_inactive');
  });
});
