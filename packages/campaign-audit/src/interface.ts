/**
 * Campaign PII-action audit writer (`@aggregator-dpg/campaign-audit`).
 *
 * Write-only: there is no update, delete or read method, which keeps the audit
 * append-only. Do not add a read method; compliance queries the table directly.
 *
 * Never pass a participant PII value into these inputs. Use field names and
 * counts only; `recipientRef` is an operator address.
 *
 * @module @aggregator-dpg/campaign-audit
 */
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';

/** The audited action. */
export type AuditChannel = 'export' | 'email' | 'voice';

/** Result of a completed action. Never set on a `requested` row. */
export type AuditOutcome = 'succeeded' | 'partial' | 'failed';

/**
 * The `requested` row, written by the API when a campaign is accepted.
 *
 * Carries the fields only the HTTP request knows: `requestIp`, `actorAzp`,
 * `endpoint` and the Keycloak subject. The worker cannot recover them later.
 */
export interface RequestedAuditInput {
  /** = `campaign_job.id`. */
  correlationId: string;
  channel: AuditChannel;
  actorUserId: string;
  actorSignalstackOrgId: string;
  actorAzp?: string;
  /** PII field names this action will release. Never values. */
  piiFields: string[];
  itemCount: number;
  requestedAt: Date;
  network?: string;
  instance?: string;
  requestIp?: string;
  /** From the request envelope's `metadata` `purpose` key, when present. */
  purpose?: string;
  endpoint: string;
  /** Inbound `x-request-id`. */
  traceId?: string;
}

/**
 * The `completed` row, written by the worker once the job reaches a terminal
 * status. Never written for an attempt that will be retried.
 *
 * `actorSignalstackOrgId` is repeated so per-org queries need no self-join.
 */
export interface CompletedAuditInput {
  correlationId: string;
  channel: AuditChannel;
  actorSignalstackOrgId: string;
  outcome: AuditOutcome;
  completedAt: Date;
  /** `raya` | the mail provider | `s3://bucket/key`. */
  destination?: string;
  resolvedCount?: number;
  skippedCount?: number;
  failedCount?: number;
  sentCount?: number;
  errorCode?: string;
  /** Export-link recipient. An operator address. */
  recipientRef?: string;
}

/**
 * Append-only audit writer. Implementations must not expose update, delete or read.
 */
export abstract class CampaignAuditWriterBase {
  /**
   * Appends the `requested` row when the API accepts a campaign action.
   *
   * @param input - Requester identity, endpoint, PII field names and item count.
   * @returns ok(void) on insert; err(BaseError) on validation or database failure.
   */
  abstract recordRequested(input: RequestedAuditInput): Promise<Result<void, BaseError>>;

  /**
   * Appends the `completed` row once a campaign job reaches a terminal status.
   * Do not call it for an attempt that will be retried.
   *
   * @param input - Outcome and counts, keyed by the `recordRequested` `correlationId`.
   * @returns ok(void) on insert; err(BaseError) on validation or database failure.
   */
  abstract recordCompleted(input: CompletedAuditInput): Promise<Result<void, BaseError>>;
}
