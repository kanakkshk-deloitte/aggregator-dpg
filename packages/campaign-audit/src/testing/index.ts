/**
 * In-memory audit writer for tests, plus input builders.
 *
 * Exposes the captured rows for test assertions. The production interface
 * stays write-only.
 *
 * @module @aggregator-dpg/campaign-audit/testing
 */
import { ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import {
  CampaignAuditWriterBase,
  type RequestedAuditInput,
  type CompletedAuditInput,
} from '../interface.js';

/** One captured row, tagged with which method produced it. */
export type AuditRow =
  ({ kind: 'requested' } & RequestedAuditInput) | ({ kind: 'completed' } & CompletedAuditInput);

/**
 * In-memory {@link CampaignAuditWriterBase} for unit tests.
 *
 * Captures every row (tagged by kind) in `rows`. When `failWith` is set, every
 * method throws that error instead of returning `err(...)`, so tests can check
 * callers survive a throwing writer.
 */
export class CampaignAuditWriterFake extends CampaignAuditWriterBase {
  /** Rows captured so far, in call order. */
  readonly rows: AuditRow[] = [];
  /** When set, every method throws this instead of writing a row. */
  failWith: Error | null = null;

  /**
   * Captures a `requested` row in `rows`, tagged `kind: 'requested'`.
   *
   * Throws `failWith` instead of recording anything when it is set.
   *
   * @param input - The requested-audit fields to capture.
   * @returns `ok(undefined)` once the row has been pushed onto `rows`.
   */
  override async recordRequested(input: RequestedAuditInput): Promise<Result<void, BaseError>> {
    if (this.failWith) throw this.failWith;
    this.rows.push({ kind: 'requested', ...input });
    return ok(undefined);
  }

  /**
   * Captures a `completed` row in `rows`, tagged `kind: 'completed'`.
   *
   * Throws `failWith` instead of recording anything when it is set.
   *
   * @param input - The completed-audit fields to capture.
   * @returns `ok(undefined)` once the row has been pushed onto `rows`.
   */
  override async recordCompleted(input: CompletedAuditInput): Promise<Result<void, BaseError>> {
    if (this.failWith) throw this.failWith;
    this.rows.push({ kind: 'completed', ...input });
    return ok(undefined);
  }

  /** Clears captured rows and the `failWith` override, for test isolation. */
  reset(): void {
    this.rows.length = 0;
    this.failWith = null;
  }
}

/**
 * Builds a valid `requested` input. Defaults are deterministic (fixed uuid,
 * fixed date, operator identities only) so tests are reproducible and never
 * carry a participant PII value.
 *
 * @param over - Fields to override on top of the defaults.
 * @returns A complete {@link RequestedAuditInput}.
 */
export function buildRequestedAudit(over: Partial<RequestedAuditInput> = {}): RequestedAuditInput {
  return {
    correlationId: '00000000-0000-4000-8000-000000000001',
    channel: 'export',
    actorUserId: 'kc-sub-1',
    actorSignalstackOrgId: 'org_test',
    actorAzp: 'campaign-manager',
    piiFields: ['name', 'email', 'phone'],
    itemCount: 3,
    requestedAt: new Date('2026-09-02T10:00:00.000Z'),
    endpoint: 'POST /v1/campaign/export',
    ...over,
  };
}

/**
 * Builds a valid `completed` input. Defaults are deterministic and contain no
 * participant PII.
 *
 * @param over - Fields to override on top of the defaults.
 * @returns A complete {@link CompletedAuditInput}.
 */
export function buildCompletedAudit(over: Partial<CompletedAuditInput> = {}): CompletedAuditInput {
  return {
    correlationId: '00000000-0000-4000-8000-000000000001',
    channel: 'export',
    actorSignalstackOrgId: 'org_test',
    outcome: 'succeeded',
    completedAt: new Date('2026-09-02T10:00:05.000Z'),
    resolvedCount: 3,
    skippedCount: 0,
    failedCount: 0,
    ...over,
  };
}
