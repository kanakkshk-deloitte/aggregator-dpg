import { describe, it, expect } from 'vitest';
import { toConsentDocs } from '@/components/consent/consent-docs';
import type { ParticipantConsent } from '@/components/consent/consent-types';

const base = {
  terms: { version: 1, title: 'Terms of Service', content: '## Terms body' },
  privacy: { version: 1, title: 'Privacy Policy', content: '## Privacy body' },
};

describe('toConsentDocs', () => {
  it('returns privacy then terms for plain consent content', () => {
    const docs = toConsentDocs(base);
    expect(docs.map((d) => d.id)).toEqual(['privacy', 'terms']);
    expect(docs[0]!.title).toBe('Privacy Policy');
    expect(docs[0]!.body).toBe('## Privacy body');
  });

  it('appends the profile-creation statement when present', () => {
    const withProfile: ParticipantConsent = {
      ...base,
      profileCreation: { version: 1, statement: 'Used to match you with services.' },
    };
    const docs = toConsentDocs(withProfile);
    expect(docs.map((d) => d.id)).toEqual(['privacy', 'terms', 'profile']);
    expect(docs[2]!.body).toBe('Used to match you with services.');
  });

  it('returns an empty list when content is missing', () => {
    expect(toConsentDocs(undefined)).toEqual([]);
  });
});
