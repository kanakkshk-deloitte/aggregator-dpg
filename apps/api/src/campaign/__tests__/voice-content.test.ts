/**
 * Unit tests for the voice campaign content schema.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect } from 'vitest';
import { voiceContentSchema, voiceStartOptions } from '../voice-content.js';

describe('voiceContentSchema', () => {
  it('parses a minimal voice content with required agent_id', () => {
    const parsed = voiceContentSchema.parse({ agent_id: 'agent-123' });
    expect(parsed.agent_id).toBe('agent-123');
    expect(parsed.action).toBe('dispatch');
    expect(parsed.provider).toBeUndefined();
    expect(parsed.batch_name).toBeUndefined();
    expect(parsed.variables).toBeUndefined();
  });

  it('defaults action to "dispatch"', () => {
    const parsed = voiceContentSchema.parse({ agent_id: 'agent-123' });
    expect(parsed.action).toBe('dispatch');
  });

  it('accepts explicit action "dispatch"', () => {
    const parsed = voiceContentSchema.parse({ agent_id: 'agent-123', action: 'dispatch' });
    expect(parsed.action).toBe('dispatch');
  });

  it('rejects action values other than "dispatch"', () => {
    const res = voiceContentSchema.safeParse({ agent_id: 'agent-123', action: 'other' });
    expect(res.success).toBe(false);
  });

  it('rejects missing agent_id', () => {
    const res = voiceContentSchema.safeParse({ action: 'dispatch' });
    expect(res.success).toBe(false);
  });

  it('rejects empty agent_id', () => {
    const res = voiceContentSchema.safeParse({ agent_id: '' });
    expect(res.success).toBe(false);
  });

  it('accepts optional provider "raya"', () => {
    const parsed = voiceContentSchema.parse({ agent_id: 'agent-123', provider: 'raya' });
    expect(parsed.provider).toBe('raya');
  });

  it('rejects unknown provider value', () => {
    const res = voiceContentSchema.safeParse({ agent_id: 'agent-123', provider: 'unknown' });
    expect(res.success).toBe(false);
  });

  it('accepts optional batch_name with length 1-200', () => {
    const parsed = voiceContentSchema.parse({ agent_id: 'agent-123', batch_name: 'my batch' });
    expect(parsed.batch_name).toBe('my batch');
  });

  it('rejects empty batch_name', () => {
    const res = voiceContentSchema.safeParse({ agent_id: 'agent-123', batch_name: '' });
    expect(res.success).toBe(false);
  });

  it('rejects batch_name exceeding 200 chars', () => {
    const longName = 'x'.repeat(201);
    const res = voiceContentSchema.safeParse({ agent_id: 'agent-123', batch_name: longName });
    expect(res.success).toBe(false);
  });

  it('accepts optional variables as string array', () => {
    const parsed = voiceContentSchema.parse({
      agent_id: 'agent-123',
      variables: ['var1', 'var2'],
    });
    expect(parsed.variables).toEqual(['var1', 'var2']);
  });

  it('rejects variables with empty strings', () => {
    const res = voiceContentSchema.safeParse({
      agent_id: 'agent-123',
      variables: ['var1', ''],
    });
    expect(res.success).toBe(false);
  });

  it('accepts optional schedule passthrough object', () => {
    const schedule = { date: '2026-08-26', time: '10:00' };
    const parsed = voiceContentSchema.parse({
      agent_id: 'agent-123',
      schedule,
    });
    expect(parsed.schedule).toEqual(schedule);
  });

  it('accepts optional max_retries as non-negative integer', () => {
    const parsed = voiceContentSchema.parse({
      agent_id: 'agent-123',
      max_retries: 3,
    });
    expect(parsed.max_retries).toBe(3);
  });

  it('rejects negative max_retries', () => {
    const res = voiceContentSchema.safeParse({
      agent_id: 'agent-123',
      max_retries: -1,
    });
    expect(res.success).toBe(false);
  });

  it('rejects non-integer max_retries', () => {
    const res = voiceContentSchema.safeParse({
      agent_id: 'agent-123',
      max_retries: 3.5,
    });
    expect(res.success).toBe(false);
  });

  it('accepts optional retry_after_hrs as non-negative number', () => {
    const parsed = voiceContentSchema.parse({
      agent_id: 'agent-123',
      retry_after_hrs: 2.5,
    });
    expect(parsed.retry_after_hrs).toBe(2.5);
  });

  it('rejects negative retry_after_hrs', () => {
    const res = voiceContentSchema.safeParse({
      agent_id: 'agent-123',
      retry_after_hrs: -1,
    });
    expect(res.success).toBe(false);
  });

  it('accepts optional max_concurrent_calls as positive integer', () => {
    const parsed = voiceContentSchema.parse({
      agent_id: 'agent-123',
      max_concurrent_calls: 10,
    });
    expect(parsed.max_concurrent_calls).toBe(10);
  });

  it('rejects non-positive max_concurrent_calls', () => {
    const res = voiceContentSchema.safeParse({
      agent_id: 'agent-123',
      max_concurrent_calls: 0,
    });
    expect(res.success).toBe(false);
  });

  it('rejects non-integer max_concurrent_calls', () => {
    const res = voiceContentSchema.safeParse({
      agent_id: 'agent-123',
      max_concurrent_calls: 10.5,
    });
    expect(res.success).toBe(false);
  });

  it('accepts optional selected_statuses as string array', () => {
    const parsed = voiceContentSchema.parse({
      agent_id: 'agent-123',
      selected_statuses: ['active', 'pending'],
    });
    expect(parsed.selected_statuses).toEqual(['active', 'pending']);
  });

  it('rejects unknown top-level keys (strict envelope)', () => {
    const res = voiceContentSchema.safeParse({
      agent_id: 'agent-123',
      unknown_field: 'should fail',
    });
    expect(res.success).toBe(false);
  });

  it('parses full voice content with all fields', () => {
    const schedule = { date: '2026-08-26' };
    const parsed = voiceContentSchema.parse({
      action: 'dispatch',
      provider: 'raya',
      agent_id: 'agent-123',
      batch_name: 'batch-1',
      variables: ['var1', 'var2'],
      schedule,
      max_retries: 3,
      retry_after_hrs: 2,
      max_concurrent_calls: 5,
      selected_statuses: ['active'],
    });
    expect(parsed.action).toBe('dispatch');
    expect(parsed.provider).toBe('raya');
    expect(parsed.agent_id).toBe('agent-123');
    expect(parsed.batch_name).toBe('batch-1');
    expect(parsed.variables).toEqual(['var1', 'var2']);
    expect(parsed.schedule).toEqual(schedule);
    expect(parsed.max_retries).toBe(3);
    expect(parsed.retry_after_hrs).toBe(2);
    expect(parsed.max_concurrent_calls).toBe(5);
    expect(parsed.selected_statuses).toEqual(['active']);
  });
});

describe('voiceStartOptions', () => {
  it('returns empty object when no passthrough keys are present', () => {
    const content = voiceContentSchema.parse({ agent_id: 'agent-123' });
    const options = voiceStartOptions(content);
    expect(options).toEqual({});
  });

  it('returns only schedule when supplied', () => {
    const schedule = { date: '2026-08-26', time: '10:00' };
    const content = voiceContentSchema.parse({
      agent_id: 'agent-123',
      schedule,
    });
    const options = voiceStartOptions(content);
    expect(options).toEqual({ schedule });
  });

  it('returns only max_retries when supplied', () => {
    const content = voiceContentSchema.parse({
      agent_id: 'agent-123',
      max_retries: 3,
    });
    const options = voiceStartOptions(content);
    expect(options).toEqual({ max_retries: 3 });
  });

  it('returns only retry_after_hrs when supplied', () => {
    const content = voiceContentSchema.parse({
      agent_id: 'agent-123',
      retry_after_hrs: 2.5,
    });
    const options = voiceStartOptions(content);
    expect(options).toEqual({ retry_after_hrs: 2.5 });
  });

  it('returns only max_concurrent_calls when supplied', () => {
    const content = voiceContentSchema.parse({
      agent_id: 'agent-123',
      max_concurrent_calls: 10,
    });
    const options = voiceStartOptions(content);
    expect(options).toEqual({ max_concurrent_calls: 10 });
  });

  it('returns only selected_statuses when supplied', () => {
    const content = voiceContentSchema.parse({
      agent_id: 'agent-123',
      selected_statuses: ['active', 'pending'],
    });
    const options = voiceStartOptions(content);
    expect(options).toEqual({ selected_statuses: ['active', 'pending'] });
  });

  it('returns multiple passthrough keys when supplied', () => {
    const schedule = { date: '2026-08-26' };
    const content = voiceContentSchema.parse({
      agent_id: 'agent-123',
      schedule,
      max_retries: 3,
      retry_after_hrs: 2,
      max_concurrent_calls: 5,
      selected_statuses: ['active'],
    });
    const options = voiceStartOptions(content);
    expect(options).toEqual({
      schedule,
      max_retries: 3,
      retry_after_hrs: 2,
      max_concurrent_calls: 5,
      selected_statuses: ['active'],
    });
  });

  it('ignores non-passthrough fields', () => {
    const content = voiceContentSchema.parse({
      agent_id: 'agent-123',
      action: 'dispatch',
      provider: 'raya',
      batch_name: 'batch-1',
      variables: ['var1'],
      max_retries: 3,
    });
    const options = voiceStartOptions(content);
    expect(options).toEqual({ max_retries: 3 });
    expect(options).not.toHaveProperty('agent_id');
    expect(options).not.toHaveProperty('action');
    expect(options).not.toHaveProperty('provider');
    expect(options).not.toHaveProperty('batch_name');
    expect(options).not.toHaveProperty('variables');
  });
});
