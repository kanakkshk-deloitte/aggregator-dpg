/**
 * Unit tests for the `content.variables` → audit `piiFields` boundary
 * sanitiser (aggregator-dpg#617, fix-round-1 + fix-round-2). See
 * `../audit-field-names.ts` for why this boundary exists.
 *
 * @module apps/api/campaign/audit-field-names.test
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeAuditFieldNames,
  auditFieldNameEntries,
  MAX_FIELD_NAME_LENGTH,
  MAX_FIELD_NAME_COUNT,
} from '../audit-field-names.js';

describe('sanitizeAuditFieldNames', () => {
  it('passes identifier-shaped names through unchanged, in order', () => {
    const result = sanitizeAuditFieldNames(['role', 'city', 'signalstack_org_id']);
    expect(result).toEqual({
      names: ['role', 'city', 'signalstack_org_id'],
      droppedCount: 0,
      tooLongCount: 0,
      overLimitCount: 0,
    });
  });

  it('drops a value containing a space', () => {
    const result = sanitizeAuditFieldNames(['role', 'Ananya Rao']);
    expect(result.names).toEqual(['role']);
    expect(result.droppedCount).toBe(1);
    expect(result.tooLongCount).toBe(0);
    expect(result.overLimitCount).toBe(0);
  });

  it('drops a value containing an @', () => {
    const result = sanitizeAuditFieldNames(['role', 'ananya@example.org']);
    expect(result.names).toEqual(['role']);
    expect(result.droppedCount).toBe(1);
  });

  it('drops a value that starts with a digit', () => {
    const result = sanitizeAuditFieldNames(['role', '2fa_code']);
    expect(result.names).toEqual(['role']);
    expect(result.droppedCount).toBe(1);
  });

  it('drops a value carrying phone-shaped punctuation', () => {
    const result = sanitizeAuditFieldNames(['role', '+919876543210']);
    expect(result.names).toEqual(['role']);
    expect(result.droppedCount).toBe(1);
  });

  it('drops a non-ASCII value', () => {
    const result = sanitizeAuditFieldNames(['role', 'Ānanya']);
    expect(result.names).toEqual(['role']);
    expect(result.droppedCount).toBe(1);
  });

  it('drops a value carrying an apostrophe', () => {
    const result = sanitizeAuditFieldNames(['role', "O'Brien"]);
    expect(result.names).toEqual(['role']);
    expect(result.droppedCount).toBe(1);
  });

  it('drops a value carrying a hyphen', () => {
    const result = sanitizeAuditFieldNames(['role', 'mary-jane']);
    expect(result.names).toEqual(['role']);
    expect(result.droppedCount).toBe(1);
  });

  it('reports the count accurately when everything is dropped', () => {
    const result = sanitizeAuditFieldNames(['Ananya Rao', 'ananya@example.org']);
    expect(result).toEqual({
      names: [],
      droppedCount: 2,
      tooLongCount: 0,
      overLimitCount: 0,
    });
  });

  it('returns zero dropped for an empty input', () => {
    expect(sanitizeAuditFieldNames([])).toEqual({
      names: [],
      droppedCount: 0,
      tooLongCount: 0,
      overLimitCount: 0,
    });
  });

  it('never mutates the input array', () => {
    const input = ['role', 'Ananya Rao'];
    const copy = [...input];
    sanitizeAuditFieldNames(input);
    expect(input).toEqual(copy);
  });

  it('keeps a name at exactly the length bound', () => {
    const exact = 'a'.repeat(MAX_FIELD_NAME_LENGTH);
    const result = sanitizeAuditFieldNames([exact]);
    expect(result.names).toEqual([exact]);
    expect(result.tooLongCount).toBe(0);
  });

  it('drops an identifier-shaped name one character over the length bound, counted separately from non-identifier drops', () => {
    const tooLong = 'a'.repeat(MAX_FIELD_NAME_LENGTH + 1);
    const result = sanitizeAuditFieldNames(['role', tooLong]);
    expect(result.names).toEqual(['role']);
    expect(result.tooLongCount).toBe(1);
    expect(result.droppedCount).toBe(0);
    expect(result.overLimitCount).toBe(0);
  });

  it('drops a 4096-character identifier-shaped entry as too long, not as a non-identifier', () => {
    const huge = 'a'.repeat(4096);
    const result = sanitizeAuditFieldNames([huge]);
    expect(result.names).toEqual([]);
    expect(result.tooLongCount).toBe(1);
    expect(result.droppedCount).toBe(0);
  });

  it('keeps exactly the count bound and reports the rest as over-limit, not non-identifier', () => {
    const candidates = Array.from({ length: MAX_FIELD_NAME_COUNT + 7 }, (_, i) => `field_${i}`);
    const result = sanitizeAuditFieldNames(candidates);
    expect(result.names).toHaveLength(MAX_FIELD_NAME_COUNT);
    expect(result.names).toEqual(candidates.slice(0, MAX_FIELD_NAME_COUNT));
    expect(result.overLimitCount).toBe(7);
    expect(result.droppedCount).toBe(0);
    expect(result.tooLongCount).toBe(0);
  });

  it('classifies a mix of shape failures, over-length, and over-count entries independently', () => {
    const valid = Array.from({ length: MAX_FIELD_NAME_COUNT }, (_, i) => `field_${i}`);
    const overflow = ['field_overflow_1', 'field_overflow_2'];
    const tooLong = 'x'.repeat(MAX_FIELD_NAME_LENGTH + 10);
    const nonIdentifier = 'Ananya Rao';
    const result = sanitizeAuditFieldNames([...valid, nonIdentifier, tooLong, ...overflow]);
    expect(result.names).toEqual(valid);
    expect(result.droppedCount).toBe(1);
    expect(result.tooLongCount).toBe(1);
    expect(result.overLimitCount).toBe(2);
  });

  it('bounds the adversarial probe: 5000 entries totalling tens of thousands of characters', () => {
    const candidates = Array.from({ length: 5000 }, (_, i) => `field_${i}`);
    const result = sanitizeAuditFieldNames(candidates);
    expect(result.names).toHaveLength(MAX_FIELD_NAME_COUNT);
    expect(result.overLimitCount).toBe(5000 - MAX_FIELD_NAME_COUNT);
    const totalChars = result.names.reduce((n, s) => n + s.length, 0);
    expect(totalChars).toBeLessThanOrEqual(MAX_FIELD_NAME_COUNT * MAX_FIELD_NAME_LENGTH);
  });
});

describe('auditFieldNameEntries', () => {
  it('returns only the names when nothing was dropped', () => {
    expect(auditFieldNameEntries(['role', 'city'])).toEqual(['role', 'city']);
  });

  it('appends a redaction-count summary, never the dropped value itself', () => {
    const entries = auditFieldNameEntries(['role', 'Ananya Rao', 'ananya@example.org']);
    expect(entries).toEqual(['role', '+2 redacted (non-identifier)']);
    expect(entries.join(' ')).not.toContain('Ananya Rao');
    expect(entries.join(' ')).not.toContain('ananya@example.org');
  });

  it('returns an empty array for an empty input', () => {
    expect(auditFieldNameEntries([])).toEqual([]);
  });

  it('appends a separate too-long marker, never folded into the non-identifier count', () => {
    const huge = 'a'.repeat(4096);
    const entries = auditFieldNameEntries(['role', huge]);
    expect(entries).toEqual(['role', '+1 redacted (too long)']);
    expect(entries.join(' ')).not.toContain(huge);
  });

  it('appends a separate over-limit marker when more than the cap of valid names is supplied', () => {
    const candidates = Array.from({ length: MAX_FIELD_NAME_COUNT + 3 }, (_, i) => `field_${i}`);
    const entries = auditFieldNameEntries(candidates);
    expect(entries).toHaveLength(MAX_FIELD_NAME_COUNT + 1);
    expect(entries[MAX_FIELD_NAME_COUNT]).toBe('+3 redacted (over limit)');
  });

  it('can emit all three distinct markers at once, each with its own true count', () => {
    const valid = Array.from({ length: MAX_FIELD_NAME_COUNT }, (_, i) => `field_${i}`);
    const huge = 'x'.repeat(MAX_FIELD_NAME_LENGTH + 1);
    const entries = auditFieldNameEntries([...valid, 'Ananya Rao', huge, 'field_overflow']);
    expect(entries.slice(0, MAX_FIELD_NAME_COUNT)).toEqual(valid);
    expect(entries).toContain('+1 redacted (non-identifier)');
    expect(entries).toContain('+1 redacted (too long)');
    expect(entries).toContain('+1 redacted (over limit)');
  });

  it('produces a bounded total serialised size for the adversarial probe', () => {
    const candidates = Array.from({ length: 5000 }, (_, i) => `field_${i}`);
    const entries = auditFieldNameEntries(candidates);
    const totalChars = entries.reduce((n, s) => n + s.length, 0);
    // MAX_FIELD_NAME_COUNT names at up to MAX_FIELD_NAME_LENGTH chars each,
    // plus at most 3 short summary markers — nowhere near the 53889-character
    // probe result the reviewer measured against the unbounded version.
    expect(totalChars).toBeLessThan(MAX_FIELD_NAME_COUNT * MAX_FIELD_NAME_LENGTH + 300);
  });
});
