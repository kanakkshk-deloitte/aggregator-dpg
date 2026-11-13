/**
 * Tests for the campaign auth helper — the org-scoped coordinator gate
 * (`requireCampaignAuth`). Each 403 case pins its `fields.reason` too, not
 * just the status, so the test proves which check fired.
 *
 * @module apps/api/campaign/__tests__/auth.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { requireCampaignAuth } from '../auth.js';
import { _setAccessTokenVerifier, _resetJwks } from '../../services/auth/access-token.js';

/** Builds a minimal request carrying the given bearer token value. */
function req(token?: string): FastifyRequest {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as FastifyRequest;
}

const NO_AGGREGATOR_CLAIMS = {
  sub: 'other-uuid',
  azp: 'campaign-manager',
  preferred_username: 'someone@org.example',
};

const COORDINATOR_CLAIMS = {
  sub: 'human-uuid',
  azp: 'campaign-manager',
  preferred_username: 'coordinator@org.example',
  aggregator_id: 'agg-1',
  signalstack_org_id: 'org_5d3b7fa4',
  email: 'coordinator@org.example',
};

describe('campaign auth', () => {
  beforeEach(() => {
    _resetJwks();
    process.env.KEYCLOAK_URL = 'http://kc.local';
    process.env.KEYCLOAK_REALM = 'aggregator';
    _setAccessTokenVerifier(async (token) => {
      switch (token) {
        case 'no-aggregator':
          return NO_AGGREGATOR_CLAIMS;
        case 'coordinator':
          return COORDINATOR_CLAIMS;
        default:
          throw new Error('invalid token');
      }
    });
  });

  afterEach(() => {
    _setAccessTokenVerifier(null);
  });

  describe('requireCampaignAuth', () => {
    it('accepts a coordinator token', async () => {
      const ctx = await requireCampaignAuth(req('coordinator'));
      expect(ctx.aggregatorId).toBe('agg-1');
      expect(ctx.signalstackOrgId).toBe('org_5d3b7fa4');
    });

    it('rejects a token without aggregator_id with 403', async () => {
      await expect(requireCampaignAuth(req('no-aggregator'))).rejects.toMatchObject({
        status: 403,
        fields: { reason: 'MISSING_AGGREGATOR_ID' },
      });
    });
  });
});
