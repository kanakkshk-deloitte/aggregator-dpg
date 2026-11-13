import { describe, it, expect } from 'vitest';
import {
  classifyNonCoordinator,
  decodeJwtClaims,
  tokenAggregatorId,
  tokenRealmRoles,
} from '@/lib/jwt';

function makeToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('decodeJwtClaims', () => {
  it('decodes a well-formed token payload', () => {
    const token = makeToken({ sub: 'user-1', aggregator_id: 'agg-1' });
    expect(decodeJwtClaims(token)).toEqual({ sub: 'user-1', aggregator_id: 'agg-1' });
  });

  it('returns null when the token has fewer than 2 parts', () => {
    expect(decodeJwtClaims('onlyonepart')).toBeNull();
  });

  it('returns null when the payload is not valid base64url JSON', () => {
    expect(decodeJwtClaims('header.!!!notbase64orjson!!!.sig')).toBeNull();
  });
});

describe('tokenAggregatorId', () => {
  it('returns the aggregator_id claim when present and non-empty', () => {
    const token = makeToken({ aggregator_id: 'agg-42' });
    expect(tokenAggregatorId(token)).toBe('agg-42');
  });

  it('returns null when aggregator_id is absent', () => {
    const token = makeToken({ sub: 'user-1' });
    expect(tokenAggregatorId(token)).toBeNull();
  });

  it('returns null when aggregator_id is an empty string', () => {
    const token = makeToken({ aggregator_id: '' });
    expect(tokenAggregatorId(token)).toBeNull();
  });

  it('returns null when aggregator_id is not a string', () => {
    const token = makeToken({ aggregator_id: 123 });
    expect(tokenAggregatorId(token)).toBeNull();
  });

  it('returns null for a malformed token', () => {
    expect(tokenAggregatorId('garbage')).toBeNull();
  });
});

describe('tokenRealmRoles', () => {
  it('reads realm_access.roles', () => {
    const token = makeToken({ realm_access: { roles: ['seeker', 'offline_access'] } });
    expect(tokenRealmRoles(token)).toEqual(['seeker', 'offline_access']);
  });

  it('returns [] when realm_access is absent, null, or malformed', () => {
    expect(tokenRealmRoles(makeToken({}))).toEqual([]);
    expect(tokenRealmRoles(makeToken({ realm_access: null }))).toEqual([]);
    expect(tokenRealmRoles(makeToken({ realm_access: { roles: 'nope' } }))).toEqual([]);
  });

  it('drops non-string entries rather than trusting the claim shape', () => {
    const token = makeToken({ realm_access: { roles: ['ok', 42, null] } });
    expect(tokenRealmRoles(token)).toEqual(['ok']);
  });
});

describe('classifyNonCoordinator', () => {
  const SIGNALS = ['seeker', 'provider'];

  it('identifies a Signals participant by its realm role', () => {
    const token = makeToken({ realm_access: { roles: ['seeker'] } });
    expect(classifyNonCoordinator(token, SIGNALS)).toBe('signals_participant');
  });

  it('identifies an org owner', () => {
    const token = makeToken({ realm_access: { roles: ['org_owner'] } });
    expect(classifyNonCoordinator(token, SIGNALS)).toBe('org_owner');
  });

  it('prefers the Signals verdict when a token somehow carries both', () => {
    // Cross-app confusion is the thing being explained, so naming the other
    // app is more useful than the org-owner copy about emailed approval links.
    const token = makeToken({ realm_access: { roles: ['org_owner', 'seeker'] } });
    expect(classifyNonCoordinator(token, SIGNALS)).toBe('signals_participant');
  });

  it('falls back to unknown for any other realm user', () => {
    const token = makeToken({ realm_access: { roles: ['offline_access'] } });
    expect(classifyNonCoordinator(token, SIGNALS)).toBe('unknown');
  });

  it('falls back to unknown when the Signals roles are unconfigured', () => {
    // A wrong message is worse than a generic one, so an empty config must
    // never let a Signals user be described as something else.
    const token = makeToken({ realm_access: { roles: ['seeker'] } });
    expect(classifyNonCoordinator(token, [])).toBe('unknown');
  });
});
