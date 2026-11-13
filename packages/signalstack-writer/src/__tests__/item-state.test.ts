/**
 * Unit tests for the shared profile item_state builder.
 *
 * The phone rule is the part with a consequence: overwriting a submitted
 * 10-digit number with its E.164 form would fail signalstack's own pattern on
 * networks that expect the local form, so the raw value must win when present.
 */
import { describe, it, expect } from 'vitest';
import { buildSignalStackItemState } from '../item-state.js';

describe('buildSignalStackItemState', () => {
  it('passes the body through unchanged when it already carries a phone', () => {
    const body = { name: 'Asha', mobile_number: '9876543210' };
    expect(buildSignalStackItemState(body, '+919876543210', 'mobile_number')).toEqual(body);
  });

  it('fills the phone field from the normalised phone when the body has none', () => {
    expect(buildSignalStackItemState({ name: 'Asha' }, '+919876543210', 'mobile_number')).toEqual({
      name: 'Asha',
      mobile_number: '+919876543210',
    });
  });

  it('treats an empty phone cell as missing', () => {
    expect(
      buildSignalStackItemState({ mobile_number: '' }, '+919876543210', 'mobile_number'),
    ).toEqual({ mobile_number: '+919876543210' });
  });

  it('leaves the phone field alone when there is no normalised phone', () => {
    expect(buildSignalStackItemState({ name: 'Asha' }, null, 'mobile_number')).toEqual({
      name: 'Asha',
    });
  });

  it('does not mutate the body', () => {
    const body = { name: 'Asha' };
    buildSignalStackItemState(body, '+919876543210', 'mobile_number');
    expect(body).toEqual({ name: 'Asha' });
  });
});
