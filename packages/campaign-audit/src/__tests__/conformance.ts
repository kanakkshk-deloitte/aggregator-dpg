/**
 * Behaviour every writer must share.
 *
 * Currently exercised only against {@link CampaignAuditWriterFake}, via
 * `fake.test.ts` — `PostgresCampaignAuditWriter` has its own narrower unit
 * tests (`postgres.test.ts`, mocked `AuditDb`) but is NOT run through this
 * suite against a real Postgres instance. A real-database integration test
 * that runs this same suite against `PostgresCampaignAuditWriter` is deferred
 * to a follow-up issue (#617 final review, cheap item) — until it exists, the
 * fake and the real writer are not proven to behave identically.
 *
 * @module @aggregator-dpg/campaign-audit/__tests__/conformance
 */
import { describe, it, expect } from 'vitest';
import type { CampaignAuditWriterBase } from '../interface.js';
import { buildRequestedAudit, buildCompletedAudit } from '../testing/index.js';

/**
 * Runs the shared conformance suite against a writer produced by `makeWriter`.
 *
 * @param makeWriter - Factory returning a fresh {@link CampaignAuditWriterBase}
 *   instance for each test.
 */
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

    it('exposes no mutation surface', () => {
      const w = makeWriter() as unknown as Record<string, unknown>;
      // The append-only guarantee is the ABSENCE of these.
      expect(w.update).toBeUndefined();
      expect(w.delete).toBeUndefined();
      expect(w.find).toBeUndefined();
    });
  });
}
