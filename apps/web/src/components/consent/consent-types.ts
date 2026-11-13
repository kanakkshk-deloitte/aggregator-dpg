/**
 * Shared type for consent document content passed to widgets and modals.
 *
 * @module apps/web/src/components/consent/consent-types
 */

/**
 * Content of a single consent document at its current version.
 *
 * Holds the versioned terms and privacy text so the UI can show them without
 * another fetch.
 */
export interface ConsentDocContent {
  /** Current-version Terms of Service document. */
  terms: { version: number; title: string; content: string; effective_from?: string };
  /** Current-version Privacy Policy document. */
  privacy: { version: number; title: string; content: string; effective_from?: string };
}

/**
 * Participant consent copy: Terms, Privacy, and the separate profile-creation
 * consent statement.
 */
export interface ParticipantConsent extends ConsentDocContent {
  /** Current-version profile-creation consent statement, when configured. */
  profileCreation?: { version: number; statement: string };
}
