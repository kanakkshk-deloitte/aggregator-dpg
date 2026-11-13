import { describe, expect, it } from 'vitest';
import { coolingRetryAfter } from './registration-cooling.js';

// Default REGISTRATION_COOLING_MINUTES = 720 (12h) when the env var is unset.
const WINDOW_MS = 720 * 60 * 1000;

describe('coolingRetryAfter (#726)', () => {
  it('returns an ISO retry-after while still inside the window', () => {
    const rejectedAt = new Date(Date.now() - 60 * 1000); // 1 min ago
    const result = coolingRetryAfter(rejectedAt, rejectedAt);
    expect(result).not.toBeNull();
    // ready-at ≈ rejectedAt + window.
    expect(new Date(result as string).getTime()).toBe(rejectedAt.getTime() + WINDOW_MS);
  });

  it('returns null once the window has elapsed', () => {
    const rejectedAt = new Date(Date.now() - WINDOW_MS - 60 * 1000); // just past
    expect(coolingRetryAfter(rejectedAt, rejectedAt)).toBeNull();
  });

  it('falls back to updatedAt when rejectedAt is null (pre-0021 rows)', () => {
    const updatedAt = new Date(Date.now() - 60 * 1000);
    const result = coolingRetryAfter(null, updatedAt);
    expect(result).not.toBeNull();
    expect(new Date(result as string).getTime()).toBe(updatedAt.getTime() + WINDOW_MS);
  });

  it('elapsed fallback (rejectedAt null, old updatedAt) returns null', () => {
    const updatedAt = new Date(Date.now() - WINDOW_MS - 1000);
    expect(coolingRetryAfter(null, updatedAt)).toBeNull();
  });
});
