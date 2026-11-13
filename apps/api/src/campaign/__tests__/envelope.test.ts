/**
 * Unit tests for the shared campaign request envelope.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { campaignEnvelopeSchema, dedupeItemIds, metadataValue } from '../envelope.js';

describe('campaignEnvelopeSchema', () => {
  it('parses a minimal envelope, defaulting metadata + content', () => {
    const parsed = campaignEnvelopeSchema.parse({ item_ids: [randomUUID()] });
    expect(parsed.metadata).toEqual([]);
    expect(parsed.content).toEqual({});
  });

  it('accepts metadata pairs and a content object', () => {
    const parsed = campaignEnvelopeSchema.parse({
      item_ids: [randomUUID()],
      metadata: [{ key: 'purpose', value: 'audit' }],
      content: { template: 'welcome' },
    });
    expect(parsed.metadata).toEqual([{ key: 'purpose', value: 'audit' }]);
    expect(parsed.content).toEqual({ template: 'welcome' });
  });

  it('rejects an empty item_ids array', () => {
    expect(campaignEnvelopeSchema.safeParse({ item_ids: [] }).success).toBe(false);
  });

  it('rejects non-uuid item ids', () => {
    expect(campaignEnvelopeSchema.safeParse({ item_ids: ['not-a-uuid'] }).success).toBe(false);
  });

  it('rejects a metadata pair with a non-string value', () => {
    const res = campaignEnvelopeSchema.safeParse({
      item_ids: [randomUUID()],
      metadata: [{ key: 'k', value: 5 }],
    });
    expect(res.success).toBe(false);
  });

  it('rejects unknown top-level keys (strict envelope)', () => {
    const res = campaignEnvelopeSchema.safeParse({ item_ids: [randomUUID()], purpose: 'audit' });
    expect(res.success).toBe(false);
  });
});

describe('dedupeItemIds', () => {
  it('removes later duplicates and preserves first-seen order', () => {
    expect(dedupeItemIds(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });
});

describe('metadataValue', () => {
  it('returns the first matching value or undefined', () => {
    const md = [
      { key: 'purpose', value: 'audit' },
      { key: 'purpose', value: 'ignored' },
    ];
    expect(metadataValue(md, 'purpose')).toBe('audit');
    expect(metadataValue(md, 'missing')).toBeUndefined();
  });
});
