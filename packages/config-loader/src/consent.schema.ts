/**
 * Zod schema and parser for the per-audience versioned consent configuration.
 *
 * Defines the shape of `consent.json` files used by the aggregator registration
 * flows. Each audience (org, aggregator) carries versioned terms and privacy
 * documents, enabling in-place version upgrades without code changes.
 *
 * Import via `@aggregator-dpg/config-loader/consent`.
 *
 * @module @aggregator-dpg/config-loader/consent
 */

import { z } from 'zod';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';

/**
 * Schema for a single version of a consent document.
 *
 * Captures the document text, its semantic version, and the date it takes
 * effect so the UI can present the right version and detect when users need
 * to re-consent after a document update.
 */
export const DocVersionSchema = z.object({
  /** Monotonically increasing integer version number (≥ 1). */
  version: z.number().int().min(1),
  /** Display title shown to the user (e.g. "Terms of Service"). */
  title: z.string(),
  /** Full Markdown content of the document. */
  content: z.string(),
  /** ISO-8601 date string (YYYY-MM-DD) when this version takes effect. */
  effective_from: z.string(),
});

/** Inferred TypeScript type for a document version record. */
export type DocVersion = z.infer<typeof DocVersionSchema>;

/**
 * Schema for a versioned consent document (terms or privacy policy).
 *
 * Enforces that `current_version` points to an existing entry in `versions`
 * and that all version integers are unique.
 */
export const DocSchema = z
  .object({
    /** The version number currently in effect; must appear in `versions`. */
    current_version: z.number().int().min(1),
    /** Ordered list of all historical and current document versions. */
    versions: z.array(DocVersionSchema),
  })
  .superRefine((doc, ctx) => {
    const nums = doc.versions.map((v) => v.version);

    // current_version must appear in versions
    if (!nums.includes(doc.current_version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `current_version ${doc.current_version} is not present in versions [${nums.join(', ')}]`,
        path: ['current_version'],
      });
    }

    // version integers must be unique
    const seen = new Set<number>();
    for (const num of nums) {
      if (seen.has(num)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate version number ${num} in versions array`,
          path: ['versions'],
        });
        break;
      }
      seen.add(num);
    }
  });

/** Inferred TypeScript type for a versioned consent document. */
export type Doc = z.infer<typeof DocSchema>;

/**
 * Schema for a single audience's consent documents (terms + privacy policy).
 */
export const AudienceSchema = z.object({
  documents: z.object({
    /** Terms of Service document. */
    terms: DocSchema,
    /** Privacy Policy document. */
    privacy: DocSchema,
    /**
     * Operator attestation shown before a bulk upload — "I have permission
     * from the individuals in this file" (#522 Task 1). Optional so the
     * existing consent.json files stay valid until they add it; only the
     * `aggregator` audience uses it.
     */
    bulk_upload_attestation: DocSchema.optional(),
  }),
});

/** Inferred TypeScript type for an audience consent block. */
export type Audience = z.infer<typeof AudienceSchema>;

/**
 * Top-level schema for a `consent.json` file.
 *
 * Contains separate consent documents for the `org` (partner organisation)
 * and `aggregator` (coordinator/aggregator) registration flows.
 */
export const AggregatorConsentConfigSchema = z.object({
  audiences: z.object({
    /** Consent documents shown during organisation registration. */
    org: AudienceSchema,
    /** Consent documents shown during aggregator registration. */
    aggregator: AudienceSchema,
  }),
});

/** Inferred TypeScript type for the full aggregator consent configuration. */
export type AggregatorConsentConfig = z.infer<typeof AggregatorConsentConfigSchema>;

/**
 * Parses and validates raw JSON data against the AggregatorConsentConfigSchema.
 *
 * Intended for use at application startup — throws rather than returning a
 * Result so that misconfigured deployments fail fast and loudly.
 *
 * @param raw - The parsed JSON value to validate.
 * @returns The validated AggregatorConsentConfig.
 * @throws {ConfigError} If the value does not match the schema.
 */
export function parseAggregatorConsentConfig(raw: unknown): AggregatorConsentConfig {
  const result = AggregatorConsentConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      `Invalid consent config: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      {
        code: 'CONSENT_CONFIG_INVALID',
        details: { issues: result.error.issues },
      },
    );
  }
  return result.data;
}
