/**
 * Builds the ordered document list the consent gate reads.
 *
 * Order is fixed: privacy, terms, profile.
 *
 * @module apps/web/src/components/consent/consent-docs
 */
import type { ConsentDocContent, ParticipantConsent } from './consent-types';

/** One document in the guided read. `cap` labels its tracker dot. */
export interface ConsentDoc {
  id: string;
  cap: string;
  title: string;
  body: string;
}

/**
 * Flattens consent content into the ordered list the gate renders.
 *
 * @param content - Consent copy, or undefined when the loader failed at boot.
 * @returns Ordered documents; empty when there is nothing to show.
 */
export function toConsentDocs(
  content: ConsentDocContent | ParticipantConsent | undefined,
): ConsentDoc[] {
  if (!content) return [];
  const docs: ConsentDoc[] = [
    { id: 'privacy', cap: 'Privacy', title: content.privacy.title, body: content.privacy.content },
    { id: 'terms', cap: 'Terms', title: content.terms.title, body: content.terms.content },
  ];
  const profile = (content as ParticipantConsent).profileCreation;
  if (profile) {
    docs.push({
      id: 'profile',
      cap: 'Profile',
      title: 'Profile creation',
      body: profile.statement,
    });
  }
  return docs;
}
