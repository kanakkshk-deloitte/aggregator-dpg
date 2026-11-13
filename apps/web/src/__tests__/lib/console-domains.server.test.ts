import { describe, expect, it } from 'vitest';
import { servedDomains } from '@/lib/console-domains.server';

const domains = [
  { id: 'seeker', label: 'Seekers' },
  { id: 'service_provider', label: 'Service providers' },
];

describe('servedDomains', () => {
  it('returns every configured domain for an empty list', () => {
    expect(servedDomains([], domains)).toEqual(domains);
  });

  it('labels the served ids and keeps an unknown id as its own label', () => {
    expect(servedDomains(['service_provider', 'tutor'], domains)).toEqual([
      { id: 'service_provider', label: 'Service providers' },
      { id: 'tutor', label: 'tutor' },
    ]);
  });
});
