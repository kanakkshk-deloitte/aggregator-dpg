/**
 * Server-side loader for the PARTICIPANT consent copy (Terms / Privacy) shown
 * on the public registration form.
 *
 * INTERIM (#522): the authoritative source is Signals' upcoming public endpoint
 * `GET /api/v1/consent/active?network=&audience=participant&variant=adult`
 * (§4.1). Until that ships, the participant `consent.json` is copied verbatim
 * from Signals into the aggregator config tree
 * (`config/<network>/schemas/participant/consent.json`) and read here — so the
 * form can render the real Terms/Privacy text now. When the endpoint lands,
 * swap {@link loadParticipantConsent}'s body to fetch it; the returned
 * {@link ConsentDocContent} shape (and every caller) stays unchanged.
 *
 * This is distinct from the aggregator's OWN `consent.json`
 * (`schemas/aggregator/`), which stays operator-only. Do not merge the two.
 *
 * @module apps/web/src/lib/participant-consent.server
 */

import 'server-only';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveSchemaRoot } from './config-paths';
import type { ConsentDocContent, ParticipantConsent } from '../components/consent/consent-types';

export type { ParticipantConsent };

/** Default grievances/support contact rendered into the `__SUPPORT_EMAIL__` token. */
const DEFAULT_SUPPORT_EMAIL = 'hello@bluedotseconomy.org';

/** One version entry inside a Signals `consent.json` document. */
interface ConsentVersion {
  version: number;
  title: string;
  content: string;
  effective_from?: string;
}

/** A Signals `consent.json` document (`terms` / `privacy`). */
interface ConsentDoc {
  current_version: number;
  versions: ConsentVersion[];
}

/** Profile-creation consent document — a short `statement`, not title+content. */
interface StatementDoc {
  current_version: number;
  versions: { version: number; statement: string; effective_from?: string }[];
}

/** The subset of the Signals participant `consent.json` this loader reads. */
interface ParticipantConsentFile {
  documents?: { terms?: ConsentDoc; privacy?: ConsentDoc; profile_creation?: StatementDoc };
}

/**
 * Resolves `schemas/participant/consent.json` under the active network/brand.
 * `CONFIG_ROOT` (Kubernetes mount) wins; otherwise falls back to the first
 * cwd-relative candidate that exists (dev vs Docker cwd).
 *
 * @returns Absolute path to the participant consent file, or null if none found.
 */
function resolveParticipantConsentPath(): string | null {
  const candidates = [
    path.join(resolveSchemaRoot(), 'participant', 'consent.json'),
    path.resolve(process.cwd(), '../../config/blue_dot/schemas/participant/consent.json'),
    path.resolve(process.cwd(), '../config/blue_dot/schemas/participant/consent.json'),
    path.resolve(process.cwd(), 'config/blue_dot/schemas/participant/consent.json'),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/**
 * Picks the current-version entry of a consent document and renders the
 * `__SUPPORT_EMAIL__` token to the deploy-time support address.
 */
function toCurrent(doc: ConsentDoc, supportEmail: string): ConsentDocContent['terms'] {
  const v = doc.versions.find((x) => x.version === doc.current_version) ?? doc.versions[0];
  return {
    version: v?.version ?? doc.current_version,
    title: v?.title ?? '',
    content: (v?.content ?? '').replaceAll('__SUPPORT_EMAIL__', supportEmail),
  };
}

/**
 * Loads the participant Terms + Privacy copy at their current versions for the
 * public registration form's consent modal. Returns null (form falls back to a
 * plain checkbox label) when the file is missing or malformed — never throws,
 * so a consent-copy problem can't take down the public page.
 *
 * @returns The versioned Terms/Privacy (+ profile-creation) content, or null.
 */
export async function loadParticipantConsent(): Promise<ParticipantConsent | null> {
  const file = resolveParticipantConsentPath();
  if (!file) return null;
  const supportEmail = process.env.CONSENT_SUPPORT_EMAIL?.trim() || DEFAULT_SUPPORT_EMAIL;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as ParticipantConsentFile;
    const terms = parsed.documents?.terms;
    const privacy = parsed.documents?.privacy;
    if (!terms?.versions?.length || !privacy?.versions?.length) return null;
    const pc = parsed.documents?.profile_creation;
    const pcVersion =
      pc?.versions?.find((x) => x.version === pc.current_version) ?? pc?.versions[0];
    return {
      terms: toCurrent(terms, supportEmail),
      privacy: toCurrent(privacy, supportEmail),
      ...(pcVersion
        ? {
            profileCreation: {
              version: pcVersion.version,
              statement: pcVersion.statement.replaceAll('__SUPPORT_EMAIL__', supportEmail),
            },
          }
        : {}),
    };
  } catch {
    return null;
  }
}
