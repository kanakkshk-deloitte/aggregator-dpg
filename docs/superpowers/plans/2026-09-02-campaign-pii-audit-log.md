# Campaign PII-Action Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an append-only audit log recording every campaign action that releases data — export, voice, email and the non-PII dump — on the 5W-2H principle, for DPDP accountability.

**Architecture:** A new `campaign_pii_audit` table defined in `packages/db-schema`, written through a new **write-only** shared package `packages/campaign-audit` that both `apps/api` and `apps/worker` import. Three call sites, all of them existing choke-points: `submitCampaignJob` writes the `requested` row, `runCampaignJob` writes the `completed` row on terminal status, and the dump route writes its single row. Every write is best-effort — wrapped, logged on failure, never rethrown.

**Tech Stack:** TypeScript (ESM, strict), Drizzle ORM, Postgres, Vitest, pnpm workspaces, Fastify, BullMQ.

**Spec:** `docs/superpowers/specs/2026-09-01-campaign-pii-audit-log-design.md`

## Global Constraints

- **`Result` discriminates on `success`, not `ok`.** `ok<T>(v)` returns `{ success: true, value }`
  and `err<E>(e)` returns `{ success: false, error }` (`shared-primitives/result`). The `.ok` shape
  belongs to `packages/mailer`'s unrelated local `MailerResult` — do not copy it. Assert
  `expect(r.success)`.

- **Never write a participant PII value.** Field _names_ and counts only. Actor and recipient are operator identities. Enforced by the property test in Task 7.
- **The writer interface exposes no update, delete, or read.** That is the append-only guarantee; do not add one "for convenience".
- **Audit failures never fail a campaign.** Every call site wraps the call, logs at `error`, and continues. Never rethrow.
- **Audit writes happen after the operation is already durable** — after the job is committed and enqueued, after the job reaches terminal status, after the dump URLs are signed.
- **API-side writes are awaited with a 2s statement timeout.** Not fire-and-forget (lost on shutdown), not unbounded (can hold a response open).
- `event` is the phase (`requested` | `completed`); `outcome` is the result (`succeeded` | `partial` | `failed`), **NULL on `requested` rows**.
- A campaign produces **two** rows sharing `correlation_id = campaign_job.id`. A dump produces **one**.
- **Do not run `drizzle-kit db:generate`** — it is broken repo-wide (#698). Migrations are hand-authored, with the journal and snapshot updated by hand.
- Repo conventions: abstract class not TS interface, `Result<T, BaseError>` returns, `<Entity>Schema` Zod naming, fakes in a `./testing` subpath (`.claude/rules/interfaces.md`, `.claude/rules/testing.md`).
- Commit messages are conventional-commit format (commitlint runs on `commit-msg`).
- **Run tests capped:** `pnpm --filter <pkg> exec vitest run --pool=forks --maxWorkers=2`. Uncapped runs exhaust RAM on the dev machine.

---

## File Structure

| File                                                      | Responsibility                                          |
| --------------------------------------------------------- | ------------------------------------------------------- |
| `packages/db-schema/src/schema.ts`                        | **Modify** — add 3 enums + the `campaignPiiAudit` table |
| `apps/api/drizzle/migrations/0021_campaign_pii_audit.sql` | **Create** — hand-authored DDL                          |
| `apps/api/drizzle/migrations/meta/_journal.json`          | **Modify** — register idx 21                            |
| `packages/campaign-audit/src/interface.ts`                | **Create** — abstract writer, input types, Zod schemas  |
| `packages/campaign-audit/src/postgres.ts`                 | **Create** — Drizzle-backed writer                      |
| `packages/campaign-audit/src/testing/index.ts`            | **Create** — in-memory fake + builders                  |
| `packages/campaign-audit/src/__tests__/conformance.ts`    | **Create** — shared behaviour suite                     |
| `apps/api/src/campaign/submit-job.ts`                     | **Modify at line 135** — write `requested`              |
| `apps/worker/src/services/campaign-process/index.ts`      | **Modify** — write `completed` on terminal              |
| `apps/api/src/routes/campaign-dump.ts`                    | **Modify** — write the dump row                         |

---

## Task 1: Table definition and migration

**Files:**

- Modify: `packages/db-schema/src/schema.ts`
- Create: `apps/api/drizzle/migrations/0021_campaign_pii_audit.sql`
- Modify: `apps/api/drizzle/migrations/meta/_journal.json`

**Interfaces:**

- Consumes: nothing.
- Produces: `campaignPiiAudit` table object, `campaignAuditEventEnum`, `campaignAuditChannelEnum`, `campaignAuditOutcomeEnum` — all exported from `@aggregator-dpg/db-schema`.

- [ ] **Step 1: Add the enums to `packages/db-schema/src/schema.ts`**

Place immediately after the existing `campaignChannelEnum` declaration.

```ts
/**
 * Which phase of a campaign's life this audit row records. NOT the outcome —
 * see `campaignAuditOutcomeEnum`. A campaign produces two rows (`requested`,
 * then `completed`) sharing a correlation id; a dump produces one `completed`.
 */
export const campaignAuditEventEnum = pgEnum('campaign_audit_event', ['requested', 'completed']);

/**
 * The audited action. Wider than `campaignChannelEnum` because the non-PII dump
 * is audited too — it releases the whole-network snapshot, and is the only
 * action with no org scoping at all.
 */
export const campaignAuditChannelEnum = pgEnum('campaign_audit_channel', [
  'export',
  'email',
  'voice',
  'dump',
]);

/** Result of a completed action. NULL on `requested` rows — nothing has happened yet. */
export const campaignAuditOutcomeEnum = pgEnum('campaign_audit_outcome', [
  'succeeded',
  'partial',
  'failed',
]);
```

- [ ] **Step 2: Add the table to `packages/db-schema/src/schema.ts`**

Place immediately after the `campaignJobItem` table.

```ts
/**
 * Append-only audit of every campaign action that RELEASES DATA (#617).
 *
 * Deliberately separate from `campaign_job` / `campaign_job_item`: those are
 * mutable, derive counts and are subject to cleanup; this is immutable and
 * outlives them, including the exported S3 object which auto-deletes. Joined by
 * `correlation_id = campaign_job.id`.
 *
 * NEVER stores a participant PII value — field NAMES and counts only. The only
 * identities here are operators (the coordinator, the export-link recipient).
 *
 * Status/list GET routes are NOT audited: the rule is data release, not API
 * traffic. Clients poll every 5-10s, which would bury the real events.
 */
export const campaignPiiAudit = pgTable(
  'campaign_pii_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // = campaign_job.id. For a dump there is no job, so a uuid is generated per
    // request; the column stays NOT NULL and still groups the row.
    correlationId: uuid('correlation_id').notNull(),
    event: campaignAuditEventEnum('event').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // ── Who ────────────────────────────────────────────────────────────────
    actorUserId: text('actor_user_id'),
    // NULL for a dump, and that null is MEANINGFUL: it is the signature of a
    // whole-network access by the system account, which has no org.
    actorOrgId: text('actor_org_id'),
    actorAzp: text('actor_azp'),
    // Export-link recipient — an operator address, never a participant's.
    recipientRef: text('recipient_ref'),

    // ── What ───────────────────────────────────────────────────────────────
    channel: campaignAuditChannelEnum('channel').notNull(),
    // PII field NAMES, never values. Empty array on a dump asserts positively
    // that no PII field was released ("none, and we checked" vs null's "unknown").
    piiFields: text('pii_fields').array(),
    itemCount: integer('item_count'),

    // ── When ───────────────────────────────────────────────────────────────
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    // ── Where ──────────────────────────────────────────────────────────────
    destination: text('destination'),
    network: text('network'),
    instance: text('instance'),
    requestIp: text('request_ip'),

    // ── Why ────────────────────────────────────────────────────────────────
    purpose: text('purpose'),
    // Consent storage/gating is specced separately; present but unused.
    consentRef: text('consent_ref'),

    // ── How ────────────────────────────────────────────────────────────────
    endpoint: text('endpoint'),
    traceId: text('trace_id'),
    outcome: campaignAuditOutcomeEnum('outcome'),
    errorCode: text('error_code'),

    // ── How many ───────────────────────────────────────────────────────────
    requestedCount: integer('requested_count'),
    resolvedCount: integer('resolved_count'),
    skippedCount: integer('skipped_count'),
    failedCount: integer('failed_count'),
    sentCount: integer('sent_count'),

    // Non-PII extras. A dump carries { files, bytes } here rather than adding
    // dump-only columns.
    details: jsonb('details').$type<Record<string, unknown>>(),
  },
  (table) => [
    index('campaign_pii_audit_org_created_idx').on(table.actorOrgId, table.createdAt),
    index('campaign_pii_audit_correlation_idx').on(table.correlationId),
    index('campaign_pii_audit_channel_created_idx').on(table.channel, table.createdAt),
  ],
);
```

- [ ] **Step 3: Verify `integer` and `index` are imported**

Run: `grep -nE "^import|integer|^  index" packages/db-schema/src/schema.ts | head -20`

If `integer` is not in the `drizzle-orm/pg-core` import list, add it. Same for `index`.

- [ ] **Step 4: Typecheck the package**

Run: `pnpm --filter @aggregator-dpg/db-schema exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Hand-author `apps/api/drizzle/migrations/0021_campaign_pii_audit.sql`**

Do **not** run `drizzle-kit db:generate` — it is broken repo-wide (#698).

```sql
CREATE TYPE "campaign_audit_event" AS ENUM('requested', 'completed');--> statement-breakpoint
CREATE TYPE "campaign_audit_channel" AS ENUM('export', 'email', 'voice', 'dump');--> statement-breakpoint
CREATE TYPE "campaign_audit_outcome" AS ENUM('succeeded', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "campaign_pii_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correlation_id" uuid NOT NULL,
	"event" "campaign_audit_event" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" text,
	"actor_org_id" text,
	"actor_azp" text,
	"recipient_ref" text,
	"channel" "campaign_audit_channel" NOT NULL,
	"pii_fields" text[],
	"item_count" integer,
	"requested_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"destination" text,
	"network" text,
	"instance" text,
	"request_ip" text,
	"purpose" text,
	"consent_ref" text,
	"endpoint" text,
	"trace_id" text,
	"outcome" "campaign_audit_outcome",
	"error_code" text,
	"requested_count" integer,
	"resolved_count" integer,
	"skipped_count" integer,
	"failed_count" integer,
	"sent_count" integer,
	"details" jsonb
);--> statement-breakpoint
CREATE INDEX "campaign_pii_audit_org_created_idx" ON "campaign_pii_audit" USING btree ("actor_org_id","created_at");--> statement-breakpoint
CREATE INDEX "campaign_pii_audit_correlation_idx" ON "campaign_pii_audit" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX "campaign_pii_audit_channel_created_idx" ON "campaign_pii_audit" USING btree ("channel","created_at");
```

- [ ] **Step 6: Register the migration in `apps/api/drizzle/migrations/meta/_journal.json`**

Append to the `entries` array, copying the shape of the `idx: 20` entry and using a current epoch-millis `when`:

```json
{
  "idx": 21,
  "version": "7",
  "when": 1788400000000,
  "tag": "0021_campaign_pii_audit",
  "breakpoints": true
}
```

- [ ] **Step 7: Apply the migration to a throwaway database and verify the SHAPE**

Drizzle recording a migration as applied does not mean the schema matches it — this table family has drifted before. Verify by shape, not bookkeeping.

```bash
docker exec aggregator-postgres psql -U aggregator -d postgres \
  -c 'DROP DATABASE IF EXISTS audit_check;' -c 'CREATE DATABASE audit_check;'
docker exec -i aggregator-postgres psql -U aggregator -d audit_check -v ON_ERROR_STOP=1 \
  < apps/api/drizzle/migrations/0021_campaign_pii_audit.sql
docker exec aggregator-postgres psql -U aggregator -d audit_check -c "\d campaign_pii_audit"
docker exec aggregator-postgres psql -U aggregator -d postgres -c 'DROP DATABASE audit_check;'
```

Expected: the table creates with **29 columns** and **3 indexes** (plus the implicit primary-key index), no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/db-schema/src/schema.ts apps/api/drizzle/migrations/
git commit -m "feat(audit): add campaign_pii_audit table and migration (#617)"
```

---

## Task 2: The write-only interface

**Files:**

- Create: `packages/campaign-audit/package.json`
- Create: `packages/campaign-audit/tsconfig.json`
- Create: `packages/campaign-audit/vitest.config.ts`
- Create: `packages/campaign-audit/src/interface.ts`

**Interfaces:**

- Consumes: `Result`, `BaseError` from `@aggregator-dpg/shared-primitives`.
- Produces: `CampaignAuditWriterBase` (abstract class), and the input types `RequestedAuditInput`, `CompletedAuditInput`, `DumpAuditInput`.

- [ ] **Step 1: Create `packages/campaign-audit/package.json`**

```json
{
  "name": "@aggregator-dpg/campaign-audit",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./interface": { "import": "./dist/interface.js", "types": "./dist/interface.d.ts" },
    "./postgres": { "import": "./dist/postgres.js", "types": "./dist/postgres.d.ts" },
    "./testing": { "import": "./dist/testing/index.js", "types": "./dist/testing/index.d.ts" }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": {
    "@aggregator-dpg/db-schema": "workspace:*",
    "@aggregator-dpg/shared-primitives": "workspace:*",
    "drizzle-orm": "^0.44.6",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@aggregator-dpg/tsconfig": "workspace:*",
    "@types/node": "^22.0.0",
    "@vitest/coverage-v8": "^3.2.7",
    "typescript": "^6.0.3",
    "vitest": "^3.2.7"
  }
}
```

Confirm the `drizzle-orm` version matches the root: `grep '"drizzle-orm"' packages/db-schema/package.json`. Use whatever that says.

- [ ] **Step 2: Copy `tsconfig.json` and `vitest.config.ts` from an existing package**

```bash
cp packages/campaign-template/tsconfig.json packages/campaign-audit/tsconfig.json
cp packages/campaign-template/vitest.config.ts packages/campaign-audit/vitest.config.ts
```

- [ ] **Step 3: Write `packages/campaign-audit/src/interface.ts`**

```ts
/**
 * Campaign PII-action audit writer (#617).
 *
 * WRITE-ONLY BY DESIGN. There is no update, no delete, and no read on this
 * surface — that absence IS the append-only guarantee. A caller cannot rewrite
 * history because the vocabulary to do so does not exist. Do not add a read
 * method "for convenience": compliance queries the table directly.
 *
 * NEVER pass a participant PII value into any of these inputs. Field NAMES and
 * counts only; `recipientRef` is an operator address, never a participant's.
 *
 * @module @aggregator-dpg/campaign-audit
 */
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';

/** The audited action. Wider than the campaign channels — the dump is audited too. */
export type AuditChannel = 'export' | 'email' | 'voice' | 'dump';

/** Result of a completed action. Never set on a `requested` row. */
export type AuditOutcome = 'succeeded' | 'partial' | 'failed';

/**
 * The `requested` row, written by the API when a campaign is accepted.
 *
 * Carries the fields only the HTTP request knows — `requestIp`, `actorAzp`,
 * `endpoint`, the Keycloak subject. The worker cannot recover these later.
 */
export interface RequestedAuditInput {
  /** = `campaign_job.id`. */
  correlationId: string;
  channel: Exclude<AuditChannel, 'dump'>;
  actorUserId: string;
  actorOrgId: string;
  actorAzp?: string;
  /** PII field NAMES that this action will release. Never values. */
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
 * The `completed` row, written by the worker once the job reaches a TERMINAL
 * status. Never written for a mid-sequence attempt that will be retried.
 *
 * `actorOrgId` is repeated here on purpose: the worker already loads the job,
 * so it is free, and it keeps "everything org X did" a single indexed scan
 * instead of a self-join.
 */
export interface CompletedAuditInput {
  correlationId: string;
  channel: Exclude<AuditChannel, 'dump'>;
  actorOrgId: string;
  outcome: AuditOutcome;
  completedAt: Date;
  /** `raya` | the mail provider | `s3://bucket/key`. */
  destination?: string;
  resolvedCount?: number;
  skippedCount?: number;
  failedCount?: number;
  sentCount?: number;
  errorCode?: string;
  /** Export-link recipient — an OPERATOR address. */
  recipientRef?: string;
}

/**
 * The single row for a non-PII dump access.
 *
 * The dump is synchronous, has no org, no items and no purpose, so it produces
 * ONE row rather than the request/complete pair. `actorOrgId` is absent by
 * design — that is the signature of a whole-network access.
 */
export interface DumpAuditInput {
  /** Generated per request — there is no job to borrow an id from. */
  correlationId: string;
  actorUserId: string;
  actorAzp?: string;
  outcome: AuditOutcome;
  completedAt: Date;
  /** The bucket/prefix that was pre-signed. */
  destination?: string;
  network?: string;
  instance?: string;
  requestIp?: string;
  endpoint: string;
  traceId?: string;
  errorCode?: string;
  /** Non-PII extras, e.g. `{ files: 3, bytes: 1234 }`. */
  details?: Record<string, unknown>;
}

/**
 * Append-only audit writer. Implementations must never expose update, delete,
 * or read.
 */
export abstract class CampaignAuditWriterBase {
  abstract recordRequested(input: RequestedAuditInput): Promise<Result<void, BaseError>>;
  abstract recordCompleted(input: CompletedAuditInput): Promise<Result<void, BaseError>>;
  abstract recordDumpAccess(input: DumpAuditInput): Promise<Result<void, BaseError>>;
}
```

- [ ] **Step 4: Install and typecheck**

Run: `pnpm install && pnpm --filter @aggregator-dpg/campaign-audit exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/campaign-audit pnpm-lock.yaml
git commit -m "feat(audit): add write-only campaign-audit interface (#617)"
```

---

## Task 3: In-memory fake and conformance suite

**Files:**

- Create: `packages/campaign-audit/src/testing/index.ts`
- Create: `packages/campaign-audit/src/__tests__/conformance.ts`
- Create: `packages/campaign-audit/src/__tests__/fake.test.ts`

**Interfaces:**

- Consumes: `CampaignAuditWriterBase`, the three input types from Task 2.
- Produces: `CampaignAuditWriterFake` with a `rows: AuditRow[]` field and a `reset()` method; `runAuditWriterConformance(makeWriter)`; builders `buildRequestedAudit`, `buildCompletedAudit`, `buildDumpAudit`.

- [ ] **Step 1: Write the fake at `packages/campaign-audit/src/testing/index.ts`**

```ts
/**
 * In-memory audit writer for tests, plus input builders.
 *
 * Exposes the rows it captured so tests can assert on them — that read is a
 * TEST affordance only. The production interface stays write-only.
 */
import { ok } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import type { BaseError } from '@aggregator-dpg/shared-primitives/errors';
import {
  CampaignAuditWriterBase,
  type RequestedAuditInput,
  type CompletedAuditInput,
  type DumpAuditInput,
} from '../interface.js';

/** One captured row, tagged with which method produced it. */
export type AuditRow =
  | ({ kind: 'requested' } & RequestedAuditInput)
  | ({ kind: 'completed' } & CompletedAuditInput)
  | ({ kind: 'dump' } & DumpAuditInput);

export class CampaignAuditWriterFake extends CampaignAuditWriterBase {
  readonly rows: AuditRow[] = [];
  /** When set, every method rejects with this — for best-effort tests. */
  failWith: Error | null = null;

  async recordRequested(input: RequestedAuditInput): Promise<Result<void, BaseError>> {
    if (this.failWith) throw this.failWith;
    this.rows.push({ kind: 'requested', ...input });
    return ok(undefined);
  }

  async recordCompleted(input: CompletedAuditInput): Promise<Result<void, BaseError>> {
    if (this.failWith) throw this.failWith;
    this.rows.push({ kind: 'completed', ...input });
    return ok(undefined);
  }

  async recordDumpAccess(input: DumpAuditInput): Promise<Result<void, BaseError>> {
    if (this.failWith) throw this.failWith;
    this.rows.push({ kind: 'dump', ...input });
    return ok(undefined);
  }

  reset(): void {
    this.rows.length = 0;
    this.failWith = null;
  }
}

/**
 * Builds a valid `requested` input. Defaults are deterministic so snapshots are
 * stable, and contain NO participant PII.
 */
export function buildRequestedAudit(over: Partial<RequestedAuditInput> = {}): RequestedAuditInput {
  return {
    correlationId: '00000000-0000-4000-8000-000000000001',
    channel: 'export',
    actorUserId: 'kc-sub-1',
    actorOrgId: 'org_test',
    actorAzp: 'campaign-manager',
    piiFields: ['name', 'email', 'phone'],
    itemCount: 3,
    requestedAt: new Date('2026-09-02T10:00:00.000Z'),
    endpoint: 'POST /v1/campaign/export',
    ...over,
  };
}

export function buildCompletedAudit(over: Partial<CompletedAuditInput> = {}): CompletedAuditInput {
  return {
    correlationId: '00000000-0000-4000-8000-000000000001',
    channel: 'export',
    actorOrgId: 'org_test',
    outcome: 'succeeded',
    completedAt: new Date('2026-09-02T10:00:05.000Z'),
    resolvedCount: 3,
    skippedCount: 0,
    failedCount: 0,
    ...over,
  };
}

export function buildDumpAudit(over: Partial<DumpAuditInput> = {}): DumpAuditInput {
  return {
    correlationId: '00000000-0000-4000-8000-000000000009',
    actorUserId: 'service-account-campaign-manager',
    actorAzp: 'campaign-manager',
    outcome: 'succeeded',
    completedAt: new Date('2026-09-02T10:00:00.000Z'),
    endpoint: 'GET /v1/campaign/dump',
    details: { files: 3, bytes: 1024 },
    ...over,
  };
}
```

- [ ] **Step 2: Write the conformance suite at `packages/campaign-audit/src/__tests__/conformance.ts`**

```ts
/**
 * Behaviour every writer must share. Run against the fake here, and against the
 * real Postgres writer in its integration test, so the two cannot drift.
 */
import { describe, it, expect } from 'vitest';
import type { CampaignAuditWriterBase } from '../interface.js';
import { buildRequestedAudit, buildCompletedAudit, buildDumpAudit } from '../testing/index.js';

export function runAuditWriterConformance(makeWriter: () => CampaignAuditWriterBase): void {
  describe('conformance', () => {
    it('accepts a requested row', async () => {
      const w = makeWriter();
      const r = await w.recordRequested(buildRequestedAudit());
      expect(r.success).toBe(true);
    });

    it('accepts a completed row for the same correlation id', async () => {
      const w = makeWriter();
      const id = '00000000-0000-4000-8000-0000000000aa';
      expect((await w.recordRequested(buildRequestedAudit({ correlationId: id }))).success).toBe(
        true,
      );
      expect((await w.recordCompleted(buildCompletedAudit({ correlationId: id }))).success).toBe(
        true,
      );
    });

    it('accepts a dump row with no org', async () => {
      const w = makeWriter();
      const r = await w.recordDumpAccess(buildDumpAudit());
      expect(r.success).toBe(true);
    });

    it('exposes no mutation surface', () => {
      const w = makeWriter() as unknown as Record<string, unknown>;
      // The append-only guarantee is the ABSENCE of these.
      expect(w.update).toBeUndefined();
      expect(w.delete).toBeUndefined();
      expect(w.find).toBeUndefined();
    });
  });
}
```

- [ ] **Step 3: Write `packages/campaign-audit/src/__tests__/fake.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { CampaignAuditWriterFake, buildRequestedAudit, buildDumpAudit } from '../testing/index.js';
import { runAuditWriterConformance } from './conformance.js';

runAuditWriterConformance(() => new CampaignAuditWriterFake());

describe('CampaignAuditWriterFake', () => {
  it('captures rows tagged by kind', async () => {
    const w = new CampaignAuditWriterFake();
    await w.recordRequested(buildRequestedAudit());
    await w.recordDumpAccess(buildDumpAudit());
    expect(w.rows.map((r) => r.kind)).toEqual(['requested', 'dump']);
  });

  it('throws when failWith is set, so best-effort call sites can be tested', async () => {
    const w = new CampaignAuditWriterFake();
    w.failWith = new Error('audit down');
    await expect(w.recordRequested(buildRequestedAudit())).rejects.toThrow('audit down');
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @aggregator-dpg/campaign-audit exec vitest run --pool=forks --maxWorkers=2`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/campaign-audit
git commit -m "test(audit): add in-memory audit writer fake and conformance suite (#617)"
```

---

## Task 4: Postgres writer

**Files:**

- Create: `packages/campaign-audit/src/postgres.ts`
- Create: `packages/campaign-audit/src/index.ts`

**Interfaces:**

- Consumes: `CampaignAuditWriterBase` and inputs (Task 2); `campaignPiiAudit` (Task 1).
- Produces: `PostgresCampaignAuditWriter` (constructor takes a Drizzle db handle), exported from the package root.

- [ ] **Step 1: Write `packages/campaign-audit/src/postgres.ts`**

```ts
/**
 * Drizzle-backed audit writer.
 *
 * Only ever INSERTs. There is no update or delete here, and none should be
 * added — see the interface module doc.
 */
import { campaignPiiAudit } from '@aggregator-dpg/db-schema/schema';
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import type { Result } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError, type BaseError } from '@aggregator-dpg/shared-primitives/errors';
import {
  CampaignAuditWriterBase,
  type RequestedAuditInput,
  type CompletedAuditInput,
  type DumpAuditInput,
} from './interface.js';

/** Minimal shape this writer needs — avoids coupling to a concrete Drizzle client type. */
export interface AuditDb {
  insert: (table: typeof campaignPiiAudit) => { values: (row: unknown) => Promise<unknown> };
}

export class PostgresCampaignAuditWriter extends CampaignAuditWriterBase {
  constructor(private readonly db: AuditDb) {
    super();
  }

  async recordRequested(input: RequestedAuditInput): Promise<Result<void, BaseError>> {
    return this.insert({
      correlationId: input.correlationId,
      event: 'requested' as const,
      channel: input.channel,
      actorUserId: input.actorUserId,
      actorOrgId: input.actorOrgId,
      actorAzp: input.actorAzp ?? null,
      piiFields: input.piiFields,
      itemCount: input.itemCount,
      requestedAt: input.requestedAt,
      requestedCount: input.itemCount,
      network: input.network ?? null,
      instance: input.instance ?? null,
      requestIp: input.requestIp ?? null,
      purpose: input.purpose ?? null,
      endpoint: input.endpoint,
      traceId: input.traceId ?? null,
      // `outcome` is deliberately absent: nothing has happened yet.
    });
  }

  async recordCompleted(input: CompletedAuditInput): Promise<Result<void, BaseError>> {
    return this.insert({
      correlationId: input.correlationId,
      event: 'completed' as const,
      channel: input.channel,
      actorOrgId: input.actorOrgId,
      outcome: input.outcome,
      completedAt: input.completedAt,
      destination: input.destination ?? null,
      resolvedCount: input.resolvedCount ?? null,
      skippedCount: input.skippedCount ?? null,
      failedCount: input.failedCount ?? null,
      sentCount: input.sentCount ?? null,
      errorCode: input.errorCode ?? null,
      recipientRef: input.recipientRef ?? null,
    });
  }

  async recordDumpAccess(input: DumpAuditInput): Promise<Result<void, BaseError>> {
    return this.insert({
      correlationId: input.correlationId,
      event: 'completed' as const,
      channel: 'dump' as const,
      actorUserId: input.actorUserId,
      // actorOrgId intentionally omitted — a dump is whole-network, no org.
      actorAzp: input.actorAzp ?? null,
      // Empty, not null: asserts positively that no PII field was released.
      piiFields: [],
      outcome: input.outcome,
      completedAt: input.completedAt,
      destination: input.destination ?? null,
      network: input.network ?? null,
      instance: input.instance ?? null,
      requestIp: input.requestIp ?? null,
      endpoint: input.endpoint,
      traceId: input.traceId ?? null,
      errorCode: input.errorCode ?? null,
      details: input.details ?? null,
    });
  }

  private async insert(row: Record<string, unknown>): Promise<Result<void, BaseError>> {
    try {
      await this.db.insert(campaignPiiAudit).values(row);
      return ok(undefined);
    } catch (cause) {
      return err(
        new UpstreamError('campaign audit insert failed', {
          cause,
          code: 'CAMPAIGN_AUDIT_INSERT_FAILED',
        }),
      );
    }
  }
}
```

- [ ] **Step 2: Write `packages/campaign-audit/src/index.ts`**

```ts
export * from './interface.js';
export { PostgresCampaignAuditWriter, type AuditDb } from './postgres.js';
```

- [ ] **Step 3: Write a stubbed-db test at `packages/campaign-audit/src/__tests__/postgres.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { PostgresCampaignAuditWriter } from '../postgres.js';
import { buildRequestedAudit, buildCompletedAudit, buildDumpAudit } from '../testing/index.js';

function stubDb() {
  const values = vi.fn().mockResolvedValue(undefined);
  return { db: { insert: () => ({ values }) } as never, values };
}

describe('PostgresCampaignAuditWriter', () => {
  it('writes a requested row with no outcome', async () => {
    const { db, values } = stubDb();
    await new PostgresCampaignAuditWriter(db).recordRequested(buildRequestedAudit());
    const row = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.event).toBe('requested');
    expect(row.outcome).toBeUndefined();
    expect(row.requestedCount).toBe(3);
  });

  it('writes a completed row carrying the org for single-scan org queries', async () => {
    const { db, values } = stubDb();
    await new PostgresCampaignAuditWriter(db).recordCompleted(buildCompletedAudit());
    const row = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.event).toBe('completed');
    expect(row.actorOrgId).toBe('org_test');
    expect(row.outcome).toBe('succeeded');
  });

  it('writes a dump row with no org and an empty pii_fields', async () => {
    const { db, values } = stubDb();
    await new PostgresCampaignAuditWriter(db).recordDumpAccess(buildDumpAudit());
    const row = values.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.channel).toBe('dump');
    expect(row.actorOrgId).toBeUndefined();
    expect(row.piiFields).toEqual([]);
  });

  it('returns an err Result instead of throwing when the insert fails', async () => {
    const values = vi.fn().mockRejectedValue(new Error('db down'));
    const db = { insert: () => ({ values }) } as never;
    const r = await new PostgresCampaignAuditWriter(db).recordRequested(buildRequestedAudit());
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @aggregator-dpg/campaign-audit exec vitest run --pool=forks --maxWorkers=2 && pnpm --filter @aggregator-dpg/campaign-audit exec tsc --noEmit`
Expected: PASS, 10 tests total; no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/campaign-audit
git commit -m "feat(audit): add Postgres campaign audit writer (#617)"
```

---

## Task 5: API writes the `requested` row

**Files:**

- Create: `apps/api/src/services/campaign-audit/index.ts`
- Modify: `apps/api/src/campaign/submit-job.ts` (insert after line 135)
- Create: `apps/api/src/campaign/__tests__/submit-job.audit.test.ts`

**Interfaces:**

- Consumes: `PostgresCampaignAuditWriter`, `RequestedAuditInput` (Tasks 2, 4).
- Produces: `getCampaignAuditWriter()`, `_setCampaignAuditWriter(w)` (test seam), and `safeAudit(fn, log, ctx)` — the best-effort wrapper reused by Tasks 6 and 7.

- [ ] **Step 1: Create the accessor and the best-effort wrapper at `apps/api/src/services/campaign-audit/index.ts`**

```ts
/**
 * Process-wide audit writer accessor, plus the best-effort wrapper every call
 * site uses.
 *
 * Audit failures NEVER fail a campaign (#617). The write happens after the
 * operation is already durable, so by the time this runs the campaign exists
 * regardless of the outcome.
 */
import { PostgresCampaignAuditWriter } from '@aggregator-dpg/campaign-audit';
import type { CampaignAuditWriterBase } from '@aggregator-dpg/campaign-audit';
import { getDb } from '../../db.js';
import { logger } from '../../logger.js';

let writer: CampaignAuditWriterBase | null = null;

export function getCampaignAuditWriter(): CampaignAuditWriterBase {
  if (!writer) writer = new PostgresCampaignAuditWriter(getDb() as never);
  return writer;
}

/** Test seam. */
export function _setCampaignAuditWriter(w: CampaignAuditWriterBase | null): void {
  writer = w;
}

/**
 * Runs an audit write so that nothing it does can affect the caller.
 *
 * Awaited rather than fire-and-forget — an un-awaited promise can be lost on
 * process shutdown and surfaces as an unhandled rejection — but bounded by a
 * timeout so a stall on this table cannot hold an HTTP response open.
 */
export async function safeAudit(
  fn: () => Promise<unknown>,
  ctx: { operation: string; correlation_id: string; channel: string },
  timeoutMs = 2000,
): Promise<void> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('audit write timed out')), timeoutMs),
      ),
    ]);
  } catch (cause) {
    logger.error({
      ...ctx,
      status: 'failure',
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
```

Check the import paths first — run `ls apps/api/src/db.ts apps/api/src/logger.ts` and adjust if the module names differ.

- [ ] **Step 2: Write the failing test at `apps/api/src/campaign/__tests__/submit-job.audit.test.ts`**

Model the harness on the existing `apps/api/src/routes/campaign-export.test.ts` (same app bootstrap, same auth mock, same in-memory job store). The three assertions:

```ts
it('writes one requested audit row with the actor and no outcome', async () => {
  const res = await post({
    item_ids: [VALID_UUID],
    metadata: [{ key: 'purpose', value: 'audit' }],
    content: {},
  });
  expect(res.statusCode).toBe(202);
  const rows = auditFake.rows.filter((r) => r.kind === 'requested');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.correlationId).toBe(res.json().job_id);
  expect(rows[0]!.actorOrgId).toBe('org_5d3b7fa4-x');
  expect(rows[0]!.purpose).toBe('audit');
  expect(rows[0]!.piiFields).toEqual(['name', 'email', 'phone']);
});

it('still returns 202 when the audit write fails', async () => {
  auditFake.failWith = new Error('audit down');
  const res = await post({ item_ids: [VALID_UUID], content: {} });
  // Best effort: the campaign is already committed and enqueued by this point.
  expect(res.statusCode).toBe(202);
});

it('does not write an audit row for a status poll', async () => {
  const created = await post({ item_ids: [VALID_UUID], content: {} });
  auditFake.reset();
  await app.inject({
    method: 'GET',
    url: `/v1/campaign/export/${created.json().job_id}`,
    headers: { authorization: 'Bearer good' },
  });
  expect(auditFake.rows).toHaveLength(0);
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm --filter @aggregator-dpg/api exec vitest run src/campaign/__tests__/submit-job.audit.test.ts --pool=forks --maxWorkers=2`
Expected: FAIL — no audit rows are written yet.

- [ ] **Step 4: Add the write to `apps/api/src/campaign/submit-job.ts`**

Insert **between** the existing line 135 (`await enqueueWithCompensation(...)`) and line 137 (`await reply.code(202).send({`). Ordering matters: the job is durable and queued before this runs.

```ts
// Audit the request (#617). Best effort — the job is already committed and
// enqueued above, so nothing here can prevent the campaign from running.
await safeAudit(
  () =>
    getCampaignAuditWriter().recordRequested({
      correlationId: created.value.job.id,
      channel: opts.channel,
      actorUserId: auth.userId,
      actorOrgId: orgId,
      actorAzp: auth.azp,
      piiFields: opts.piiFields(content),
      itemCount: itemIds.length,
      requestedAt: new Date(),
      purpose: readMetadataValue(envelope.metadata, 'purpose'),
      endpoint: `POST /v1/campaign/${opts.channel}`,
      requestIp: req.ip,
      traceId: req.headers['x-request-id'] as string | undefined,
    }),
  {
    operation: 'campaignAudit.requested',
    correlation_id: created.value.job.id,
    channel: opts.channel,
  },
);
```

Add two supporting pieces in the same file:

```ts
/** Reads a value out of the envelope's open `metadata` list. */
function readMetadataValue(
  metadata: { key: string; value: string }[] | undefined,
  key: string,
): string | undefined {
  return metadata?.find((m) => m.key === key)?.value;
}
```

and a new required field on `SubmitCampaignJobOptions`:

```ts
  /**
   * PII field NAMES this channel will release, derived from the parsed content.
   * Names only — never values (#617).
   */
  piiFields: (content: Record<string, unknown>) => string[];
```

- [ ] **Step 5: Expose `azp` on `AuthContext` so `actorAzp` is real**

`AuthContext` validates the token's `azp` but never projects it, so the audit's
**Who** would silently be missing it. (`AnyAuthContext`, used by the dump route, already
has it as `authorizedParty`.) Two small edits in
`apps/api/src/services/auth/access-token.ts`:

Add to the `AuthContext` interface:

```ts
  /**
   * `azp` claim — the client that requested the token. Validated by the azp
   * gate, and recorded as the audit log's actor client (#617).
   */
  azp?: string;
```

And in `hydrateContext`, beside the existing `preferred_username` line (~163):

```ts
if (typeof claims.azp === 'string') ctx.azp = claims.azp;
```

Verify nothing else breaks: `pnpm --filter @aggregator-dpg/api exec tsc --noEmit`

- [ ] **Step 6: Supply `piiFields` at each of the three call sites**

`apps/api/src/routes/campaign-export.ts` — the field set is deployment config, not caller input:

```ts
    piiFields: () => (config.CAMPAIGN_EXPORT_FIELDS === 'full' ? ['full'] : ['name', 'email', 'phone']),
```

`apps/api/src/routes/campaign-voice.ts`:

```ts
    piiFields: (content) => ['name', 'phone', ...((content.variables as string[] | undefined) ?? [])],
```

`apps/api/src/routes/campaign-email.ts` — reuse the existing helper rather than re-deriving:

```ts
    piiFields: (content) =>
      requiredContactFields(content.subject as string, content.body_markdown as string),
```

Confirm the export name first: `git grep -n "requiredContactFields" packages/campaign-template/src`.

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @aggregator-dpg/api exec vitest run src/campaign src/routes/campaign --pool=forks --maxWorkers=2`
Expected: PASS, including the three new tests and every pre-existing campaign test.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src packages/campaign-audit
git commit -m "feat(audit): write the requested audit row on campaign submit (#617)"
```

---

## Task 6: Worker writes the `completed` row

**Files:**

- Create: `apps/worker/src/services/campaign-audit.ts`
- Modify: `apps/worker/src/services/campaign-process/index.ts`
- Modify: `apps/worker/src/services/campaign-process/index.test.ts`

**Interfaces:**

- Consumes: `CampaignAuditWriterBase`, `CompletedAuditInput` (Task 2); `PostgresCampaignAuditWriter` (Task 4).
- Produces: an `audit?: CampaignAuditWriterBase` field on `CampaignJobDeps`.

- [ ] **Step 1: Create `apps/worker/src/services/campaign-audit.ts`**

```ts
/**
 * Worker-side audit writer accessor. Mirrors the API's, against the worker's
 * own database handle.
 */
import { PostgresCampaignAuditWriter } from '@aggregator-dpg/campaign-audit';
import type { CampaignAuditWriterBase } from '@aggregator-dpg/campaign-audit';
import { getDb } from '../db.js';

let writer: CampaignAuditWriterBase | null = null;

export function getCampaignAuditWriter(): CampaignAuditWriterBase {
  if (!writer) writer = new PostgresCampaignAuditWriter(getDb() as never);
  return writer;
}

export function _setCampaignAuditWriter(w: CampaignAuditWriterBase | null): void {
  writer = w;
}
```

Verify the db module path: `ls apps/worker/src/db.ts`.

- [ ] **Step 2: Add the failing tests to `apps/worker/src/services/campaign-process/index.test.ts`**

```ts
it('writes one completed audit row when the job reaches a terminal status', async () => {
  const audit = new CampaignAuditWriterFake();
  const h = harness(job(), {}, {}, undefined, audit);
  await runCampaignJob('job-1', h.deps);

  const rows = audit.rows.filter((r) => r.kind === 'completed');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.correlationId).toBe('job-1');
  expect(rows[0]!.outcome).toBe('succeeded');
  expect(rows[0]!.actorOrgId).toBe('org-1');
});

it('writes NO completed row for a retryable mid-sequence failure', async () => {
  const audit = new CampaignAuditWriterFake();
  const h = harness(
    job(),
    {
      putObject: async () => {
        throw new Error('s3 down');
      },
    },
    {},
    { attempt: 1, maxAttempts: 3 },
    audit,
  );

  await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow('s3 down');
  // Not terminal — BullMQ will retry, so there is no outcome to record yet.
  expect(audit.rows.filter((r) => r.kind === 'completed')).toHaveLength(0);
});

it('writes one failed audit row on the final attempt', async () => {
  const audit = new CampaignAuditWriterFake();
  const h = harness(
    job(),
    {
      putObject: async () => {
        throw new Error('s3 down');
      },
    },
    {},
    { attempt: 3, maxAttempts: 3 },
    audit,
  );

  await expect(runCampaignJob('job-1', h.deps)).rejects.toThrow('s3 down');
  const rows = audit.rows.filter((r) => r.kind === 'completed');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.outcome).toBe('failed');
});

it('still completes the job when the audit write throws', async () => {
  const audit = new CampaignAuditWriterFake();
  audit.failWith = new Error('audit down');
  const h = harness(job(), {}, {}, undefined, audit);
  await expect(runCampaignJob('job-1', h.deps)).resolves.toBeUndefined();
  expect(h.jobStatuses.at(-1)).toBe('completed');
});
```

Extend the existing `harness(...)` signature with a fifth parameter `audit?: CampaignAuditWriterBase`, and pass it through as `deps.audit`.

- [ ] **Step 3: Run to confirm they fail**

Run: `pnpm --filter @aggregator-dpg/worker exec vitest run src/services/campaign-process --pool=forks --maxWorkers=2`
Expected: FAIL — no audit rows written.

- [ ] **Step 4: Add `audit` to `CampaignJobDeps`**

In `apps/worker/src/services/campaign-process/index.ts`, alongside the existing `attempt?` field:

```ts
  /** Audit writer (#617). Optional so existing tests need no change. */
  audit?: CampaignAuditWriterBase;
```

- [ ] **Step 5: Write the completed row at both terminal points**

**Success path** — immediately after `const status = await deps.client.rollUpStatus(jobId);` (line ~168):

```ts
// Terminal: the job has an outcome, so record it. Best effort (#617).
await safeAuditWorker(
  () =>
    deps.audit?.recordCompleted({
      correlationId: jobId,
      channel: job.channel as 'export' | 'email' | 'voice',
      actorOrgId: job.signalstackOrgId,
      outcome: status === 'partial' ? 'partial' : 'succeeded',
      completedAt: new Date(),
      destination: deps.lastDestination,
    }) ?? Promise.resolve(),
  deps,
  jobId,
  job.channel,
);
```

**Failure path** — inside the existing `if (isFinalAttempt) { ... }` block (line ~202), after `setJobStatus(jobId, 'failed', ...)`:

```ts
await safeAuditWorker(
  () =>
    deps.audit?.recordCompleted({
      correlationId: jobId,
      channel: job.channel as 'export' | 'email' | 'voice',
      actorOrgId: job.signalstackOrgId,
      outcome: 'failed',
      completedAt: new Date(),
      errorCode: err instanceof Error ? err.constructor.name : 'unknown',
    }) ?? Promise.resolve(),
  deps,
  jobId,
  job.channel,
);
```

And the wrapper, in the same module:

```ts
/**
 * Runs an audit write so it cannot affect the job. No timeout here: unlike the
 * API there is no HTTP response waiting, and the job has already reached its
 * terminal status.
 */
async function safeAuditWorker(
  fn: () => Promise<unknown>,
  deps: CampaignJobDeps,
  jobId: string,
  channel: string,
): Promise<void> {
  try {
    await fn();
  } catch (cause) {
    deps.log.error({
      operation: 'campaignAudit.completed',
      status: 'failure',
      job_id: jobId,
      channel,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
```

- [ ] **Step 6: Wire the real writer in `apps/worker/src/jobs/campaign-process.ts`**

Add to the `runCampaignJob` deps object:

```ts
    audit: getCampaignAuditWriter(),
```

- [ ] **Step 7: Run the tests**

Run: `pnpm --filter @aggregator-dpg/worker exec vitest run --pool=forks --maxWorkers=2`
Expected: PASS — the four new tests plus all pre-existing worker tests.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src
git commit -m "feat(audit): write the completed audit row on terminal job status (#617)"
```

---

## Task 7: Dump audit row and the no-PII property test

**Files:**

- Modify: `apps/api/src/routes/campaign-dump.ts`
- Modify: `apps/api/src/routes/campaign-dump.test.ts`
- Create: `apps/api/src/campaign/__tests__/audit-no-pii.test.ts`

**Interfaces:**

- Consumes: `getCampaignAuditWriter`, `safeAudit` (Task 5); `DumpAuditInput` (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Write the failing dump tests in `apps/api/src/routes/campaign-dump.test.ts`**

```ts
it('writes exactly one audit row with no org and empty pii_fields', async () => {
  const res = await get('/v1/campaign/dump');
  expect(res.statusCode).toBe(200);

  expect(auditFake.rows).toHaveLength(1);
  const row = auditFake.rows[0]!;
  expect(row.kind).toBe('dump');
  // A dump is synchronous and whole-network: one row, and the absent org is
  // the signature of that.
  expect((row as { actorOrgId?: string }).actorOrgId).toBeUndefined();
  expect(row.outcome).toBe('succeeded');
});

it('records a failed dump access', async () => {
  headObjectMock.mockRejectedValueOnce(new Error('s3 down'));
  await get('/v1/campaign/dump');
  expect(auditFake.rows[0]!.outcome).toBe('failed');
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `pnpm --filter @aggregator-dpg/api exec vitest run src/routes/campaign-dump.test.ts --pool=forks --maxWorkers=2`
Expected: FAIL — no audit rows.

- [ ] **Step 3: Write the dump row in `apps/api/src/routes/campaign-dump.ts`**

After the URLs are signed (success) and in the error path (failure). Use `randomUUID()` for `correlationId` — there is no job.

```ts
await safeAudit(
  () =>
    getCampaignAuditWriter().recordDumpAccess({
      correlationId: randomUUID(),
      actorUserId: auth.context.subject,
      actorAzp: auth.context.azp,
      outcome: 'succeeded',
      completedAt: new Date(),
      destination: `${config.S3_BUCKET}/${config.CAMPAIGN_DUMP_PREFIX}`,
      endpoint: 'GET /v1/campaign/dump',
      requestIp: req.ip,
      traceId: req.headers['x-request-id'] as string | undefined,
      details: { files: files.length, bytes: files.reduce((n, f) => n + f.size_bytes, 0) },
    }),
  { operation: 'campaignAudit.dump', correlation_id: 'dump', channel: 'dump' },
);
```

- [ ] **Step 4: Write the no-PII property test at `apps/api/src/campaign/__tests__/audit-no-pii.test.ts`**

This is the acceptance criterion for #617. It asserts on **serialised rows**, not column names — the realistic leak is a participant value riding along inside an error message or `details`.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { CampaignAuditWriterFake } from '@aggregator-dpg/campaign-audit/testing';

/** Distinctive values that must never appear in any audit row. */
const PII = ['Ananya Rao', 'ananya@example.org', '+919876543210'];

describe('audit rows never contain a participant PII value', () => {
  let audit: CampaignAuditWriterFake;
  beforeEach(() => {
    audit = new CampaignAuditWriterFake();
    _setCampaignAuditWriter(audit);
  });

  it('holds for a full export submit + poll cycle', async () => {
    // Seed the Signals fake so decrypted participants carry the PII values above,
    // then run a submit through the app exactly as submit-job.audit.test.ts does.
    await post({
      item_ids: [VALID_UUID],
      metadata: [{ key: 'purpose', value: 'audit' }],
      content: {},
    });

    const serialised = JSON.stringify(audit.rows);
    for (const value of PII) {
      expect(serialised).not.toContain(value);
    }
  });
});
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @aggregator-dpg/api exec vitest run src/routes/campaign-dump.test.ts src/campaign --pool=forks --maxWorkers=2`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "feat(audit): audit dump access and assert no participant PII is written (#617)"
```

---

## Task 8: Documentation and the reconciliation query

**Files:**

- Modify: `apps/api/CLAUDE.md`
- Modify: `apps/api/.env.example` — only if any new env var was introduced (none is expected)

**Interfaces:**

- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Document the log in `apps/api/CLAUDE.md`**

Add under the campaign section:

````markdown
## Campaign PII audit log (#617)

`campaign_pii_audit` is **append-only** and records every campaign action that
**releases data** — export, voice, email, and the non-PII dump. Status/list GETs
are deliberately NOT audited: the rule is data release, not API traffic, and
clients poll every 5-10s.

- A campaign writes **two** rows sharing `correlation_id = campaign_job.id`:
  `requested` from the API, `completed` from the worker on terminal status.
  A dump writes **one**, with a NULL `actor_org_id` — that null is meaningful,
  it marks a whole-network access.
- `event` is the phase, `outcome` is the result. `outcome` is NULL on
  `requested` rows.
- The writer (`@aggregator-dpg/campaign-audit`) is **write-only** — no update,
  delete or read. That absence IS the append-only guarantee; do not add one.
- Writes are **best effort**: they happen after the operation is already durable
  and never fail a campaign.

Find gaps (audit rows that should exist and do not):

```sql
SELECT j.id, j.channel, j.status, j.created_at
FROM campaign_job j
LEFT JOIN campaign_pii_audit a
  ON a.correlation_id = j.id AND a.event = 'requested'
WHERE a.id IS NULL;
```
````

The mirror check (every `completed` has a `requested`) must exclude
`channel = 'dump'`, which legitimately has no `requested` row.

````

- [ ] **Step 2: Run the full suites and typecheck**

```bash
pnpm --filter @aggregator-dpg/campaign-audit exec vitest run --pool=forks --maxWorkers=2
pnpm --filter @aggregator-dpg/api test
pnpm --filter @aggregator-dpg/worker test
pnpm typecheck
pnpm lint
````

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/CLAUDE.md
git commit -m "docs(audit): document the campaign PII audit log and gap query (#617)"
```

---

## Spec coverage

| Spec section                                                          | Task                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------- |
| §1 what is audited / not audited                                      | 5 (status-poll test), 7 (dump), 8 (docs)                        |
| §2 principles — append-only, no PII, best effort                      | 2 (write-only interface), 7 (PII test), 5/6 (best-effort tests) |
| §3 table, enums, indexes                                              | 1                                                               |
| §3 `event` vs `outcome`                                               | 1, 4 (`outcome` absent on requested)                            |
| §3 asymmetric rows, `actor_org_id` on both                            | 4, 5, 6                                                         |
| §3 `pii_fields` per channel                                           | 5 step 5                                                        |
| §4 dump one-row shape                                                 | 4, 7                                                            |
| §5 shared package, write-only, hand-authored migration                | 1, 2, 3, 4                                                      |
| §6 three write points, terminal-only completion                       | 5, 6, 7                                                         |
| §7 failure handling, timeout, reconciliation query                    | 5 (`safeAudit`), 6, 8                                           |
| §8 testing                                                            | 3, 5, 6, 7                                                      |
| §9 out of scope — retention, consent, read API, DB-level immutability | not implemented, by design                                      |
