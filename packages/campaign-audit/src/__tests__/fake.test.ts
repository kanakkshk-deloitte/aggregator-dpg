import { describe, it, expect } from 'vitest';
import {
  CampaignAuditWriterFake,
  buildRequestedAudit,
  buildCompletedAudit,
} from '../testing/index.js';
import { runAuditWriterConformance } from './conformance.js';

runAuditWriterConformance(() => new CampaignAuditWriterFake());

describe('CampaignAuditWriterFake', () => {
  it('captures rows tagged by kind', async () => {
    const w = new CampaignAuditWriterFake();
    await w.recordRequested(buildRequestedAudit());
    await w.recordCompleted(buildCompletedAudit());
    expect(w.rows.map((r) => r.kind)).toEqual(['requested', 'completed']);
  });

  it('throws when failWith is set, so best-effort call sites can be tested', async () => {
    const w = new CampaignAuditWriterFake();
    w.failWith = new Error('audit down');
    await expect(w.recordRequested(buildRequestedAudit())).rejects.toThrow('audit down');
  });
});
