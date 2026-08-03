/**
 * Shared type for consent document content passed to widgets and modals.
 *
 * @module apps/web/src/components/consent/consent-types
 */

/**
 * Content of a single consent document at its current version.
 *
 * Carries the versioned terms and privacy policy text so the UI can render
 * them in a read-only modal without re-fetching from the server.
 */
export interface ConsentDocContent {
  /** Current-version Terms of Service document. */
  terms: { version: number; title: string; content: string };
  /** Current-version Privacy Policy document. */
  privacy: { version: number; title: string; content: string };
}

/**
 * Participant consent copy: the Terms/Privacy documents plus the distinct
 * profile-creation consent statement (its own point, §3.1 — NOT terms/privacy).
 */
export interface ParticipantConsent extends ConsentDocContent {
  /** Current-version profile-creation consent statement, when configured. */
  profileCreation?: { version: number; statement: string };
}
