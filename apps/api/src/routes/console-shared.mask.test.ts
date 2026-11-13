/**
 * Unit tests for contact masking (`@aggregator-dpg/api`, RBAC R2,
 * `contact.unmask`).
 */
import { describe, expect, it } from 'vitest';
import { maskEmail, maskPhone } from './console-shared.js';

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('asha@example.org')).toBe('a***@example.org');
  });

  it('hides an address without a local part or @', () => {
    expect(maskEmail('@example.org')).toBe('***');
    expect(maskEmail('nobody')).toBe('***');
    expect(maskEmail('')).toBe('***');
  });
});

describe('maskPhone', () => {
  it('keeps the last four digits', () => {
    expect(maskPhone('+91 98765 43210')).toBe('********3210');
  });

  it('hides a short number entirely and passes null through', () => {
    expect(maskPhone('123')).toBe('****');
    expect(maskPhone(null)).toBeNull();
  });
});
