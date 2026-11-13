import { describe, it, expect, afterEach } from 'vitest';
import { defaultOrgOwnerEmail } from '../config.js';

describe('defaultOrgOwnerEmail', () => {
  const original = process.env.DEFAULT_ORG_OWNER_EMAIL;
  afterEach(() => {
    if (original === undefined) delete process.env.DEFAULT_ORG_OWNER_EMAIL;
    else process.env.DEFAULT_ORG_OWNER_EMAIL = original;
  });

  it('is null when unset or blank', () => {
    delete process.env.DEFAULT_ORG_OWNER_EMAIL;
    expect(defaultOrgOwnerEmail()).toBeNull();
    process.env.DEFAULT_ORG_OWNER_EMAIL = '   ';
    expect(defaultOrgOwnerEmail()).toBeNull();
  });

  it('trims and lowercases a configured address', () => {
    process.env.DEFAULT_ORG_OWNER_EMAIL = '  Owner@Example.ORG ';
    expect(defaultOrgOwnerEmail()).toBe('owner@example.org');
  });
});
