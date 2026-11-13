/**
 * Unit tests for PhoneWidget and withPhoneWidget.
 *
 * Covers: the fixed +91 prefix, digits only and at most 10, the stored
 * `+91…` value, reading back a stored value, an empty field clearing the
 * value, and the widget applied to nested `phone` fields only.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { WidgetProps } from '@rjsf/utils';
import { PhoneWidget, localDigits } from '@/components/forms/custom-widgets/PhoneWidget';
import { withPhoneWidget } from '@/lib/phone-ui-schema';

function renderIt(value?: string) {
  const onChange = vi.fn();
  const props = {
    id: 'root_owner_phone',
    value,
    onChange,
    onBlur: vi.fn(),
    onFocus: vi.fn(),
    placeholder: '+91 98765 43210',
    rawErrors: [],
  } as unknown as WidgetProps;
  render(<PhoneWidget {...props} />);
  return { onChange, input: screen.getByRole('textbox') as HTMLInputElement };
}

describe('<PhoneWidget />', () => {
  it('shows +91 in front and the placeholder without it', () => {
    const { input } = renderIt();
    expect(screen.getByText('+91')).toBeInTheDocument();
    expect(input).toHaveAttribute('placeholder', '98765 43210');
    expect(input).toHaveAttribute('maxLength', '10');
    expect(input).toHaveAttribute('inputMode', 'numeric');
  });

  it('keeps digits only, at most 10, and stores +91 with them', () => {
    const { input, onChange } = renderIt();
    fireEvent.change(input, { target: { value: '98a76-543 21099' } });
    expect(onChange).toHaveBeenLastCalledWith('+919876543210');
  });

  it('clears the value when the field is emptied', () => {
    const { input, onChange } = renderIt('+919876543210');
    expect(input).toHaveValue('9876543210');
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});

describe('localDigits', () => {
  it('reads the local part of stored values', () => {
    expect(localDigits('+919')).toBe('9');
    expect(localDigits('+919876543210')).toBe('9876543210');
    expect(localDigits('919876543210')).toBe('9876543210');
    expect(localDigits('9876543210')).toBe('9876543210');
    expect(localDigits(undefined)).toBe('');
  });
});

describe('withPhoneWidget', () => {
  const schema = {
    type: 'object',
    properties: {
      phone: { type: 'string' },
      owner: {
        type: 'object',
        properties: { phone: { type: 'string' }, name: { type: 'string' } },
      },
      contact: { type: 'object', properties: { phone: { type: 'string' } } },
    },
  };

  it('puts the phone widget on phone fields at any depth', () => {
    const ui = withPhoneWidget({ owner: { phone: { 'ui:placeholder': 'x' } } }, schema);
    expect(ui).toEqual({
      phone: { 'ui:widget': 'phone' },
      owner: { phone: { 'ui:placeholder': 'x', 'ui:widget': 'phone' } },
      contact: { phone: { 'ui:widget': 'phone' } },
    });
  });

  it('keeps a widget the uiSchema already picks', () => {
    const ui = withPhoneWidget({ phone: { 'ui:widget': 'hidden' } }, schema);
    expect(ui['phone']).toEqual({ 'ui:widget': 'hidden' });
  });
});
