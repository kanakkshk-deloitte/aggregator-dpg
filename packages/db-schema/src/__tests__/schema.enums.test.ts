/**
 * Regression tests for the Postgres enum definitions in `schema.ts`.
 *
 * These are structural facts, not business logic: if someone renames an
 * enum value or drops one, the application-layer validation that trusts
 * these lists (e.g. `users.status` state-machine checks) would
 * silently start rejecting/accepting the wrong values. Asserting the exact
 * `enumValues` array (order included, since Postgres enum ordinals matter
 * for `<`/`>` comparisons some call sites may rely on) catches that at
 * compile-adjacent test time instead of in production.
 *
 * @module @aggregator-dpg/db-schema
 */

import { describe, it, expect } from 'vitest';
import {
  registrationStatusEnum,
  bulkUploadStatusEnum,
  registrationLinkStatusEnum,
  linkSubmissionOutcomeEnum,
  onboardingSourceEnum,
} from '../schema.js';

describe('schema.ts enums', () => {
  it('registrationStatusEnum: pending | active | inactive | retired', () => {
    expect(registrationStatusEnum.enumName).toBe('registration_status');
    expect(registrationStatusEnum.enumValues).toEqual(['pending', 'active', 'inactive', 'retired']);
  });

  it('bulkUploadStatusEnum: the full CSV-upload lifecycle', () => {
    expect(bulkUploadStatusEnum.enumName).toBe('bulk_upload_status');
    expect(bulkUploadStatusEnum.enumValues).toEqual([
      'pending',
      'uploaded',
      'file_validating',
      'file_failed',
      'row_processing',
      'finalising',
      'completed',
      'failed',
    ]);
  });

  it('registrationLinkStatusEnum: draft | live | retired', () => {
    expect(registrationLinkStatusEnum.enumName).toBe('registration_link_status');
    expect(registrationLinkStatusEnum.enumValues).toEqual(['draft', 'live', 'retired']);
  });

  it('linkSubmissionOutcomeEnum: passed | skipped | failed', () => {
    expect(linkSubmissionOutcomeEnum.enumName).toBe('link_submission_outcome');
    expect(linkSubmissionOutcomeEnum.enumValues).toEqual(['passed', 'skipped', 'failed']);
  });

  it('onboardingSourceEnum: bulk | link', () => {
    expect(onboardingSourceEnum.enumName).toBe('onboarding_source');
    expect(onboardingSourceEnum.enumValues).toEqual(['bulk', 'link']);
  });
});
