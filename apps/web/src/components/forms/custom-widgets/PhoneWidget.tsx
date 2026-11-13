'use client';

/**
 * Mobile number input with a fixed country code in front: the person types
 * only the local digits, and the form stores `+<code><digits>`.
 *
 * Non-digits are dropped and the local part is capped at its length, so the
 * value is always the shape the API's phone rule expects.
 */

import type { WidgetProps } from '@rjsf/utils';
import { PHONE_COUNTRY_CODE, PHONE_LOCAL_DIGITS } from '@aggregator-dpg/shared-primitives/phone';
import { cn } from '../../../lib/cn';

const PREFIX = `+${PHONE_COUNTRY_CODE}`;

/** The local digits of a stored value (`+91…`, `91…` with all digits, or bare digits). */
export function localDigits(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const rest = text.startsWith(PREFIX) ? text.slice(PREFIX.length) : text;
  let digits = rest.replace(/\D/g, '');
  if (
    !text.startsWith('+') &&
    digits.length > PHONE_LOCAL_DIGITS &&
    digits.startsWith(PHONE_COUNTRY_CODE)
  ) {
    digits = digits.slice(PHONE_COUNTRY_CODE.length);
  }
  return digits.slice(0, PHONE_LOCAL_DIGITS);
}

/**
 * RJSF widget for a phone field.
 *
 * @param props - The RJSF widget props.
 */
export function PhoneWidget(props: WidgetProps) {
  const { id, value, onChange, onBlur, onFocus, disabled, readonly, placeholder, rawErrors } =
    props;
  const local = localDigits(value);
  // A placeholder written with the code ("+91 98765 43210") shows without it.
  const hint = typeof placeholder === 'string' ? placeholder.replace(PREFIX, '').trim() : '';
  return (
    <div
      className={cn(
        'bd-input flex items-center focus-within:border-(--bd-primary)',
        rawErrors?.length ? 'border-rose-400' : '',
      )}
    >
      <span className="border-r border-(--bd-border) pr-3 text-ink-600 select-none">{PREFIX}</span>
      <input
        id={id}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        maxLength={PHONE_LOCAL_DIGITS}
        className="min-w-0 flex-1 bg-transparent pl-3 outline-none"
        value={local}
        placeholder={hint}
        disabled={disabled || readonly}
        aria-describedby={`${id}__error`}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, PHONE_LOCAL_DIGITS);
          onChange(digits ? `${PREFIX}${digits}` : undefined);
        }}
        onBlur={() => onBlur(id, value)}
        onFocus={() => onFocus(id, value)}
      />
    </div>
  );
}
