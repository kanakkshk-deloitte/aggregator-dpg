/**
 * The `item_state` block sent to signalstack for a participant's profile.
 *
 * Used by the bulk-upload worker and the public registration-link route.
 *
 * @module @aggregator-dpg/signalstack-writer/item-state
 */

/**
 * Builds the profile `item_state` from a submitted row or form body.
 *
 * The body is copied unchanged, since the field names match signalstack's
 * item_state. The submitted phone value is kept because signalstack checks it
 * against the network's own pattern (e.g. `^[0-9]{10}$` or E.164). The
 * normalised phone is filled in only when the body has no phone value. The
 * E.164 phone is always sent separately as `user.phone_number`.
 *
 * @param body - The submitted row / form fields.
 * @param pushPhone - The normalised phone for this participant, if any.
 * @param phoneField - The profile field holding the phone, e.g. `mobile_number`.
 * @returns A new object; `body` is not mutated.
 */
export function buildSignalStackItemState(
  body: Record<string, unknown>,
  pushPhone: string | null,
  phoneField: string,
): Record<string, unknown> {
  const itemState: Record<string, unknown> = { ...body };
  const rawPhone = body[phoneField];
  if (pushPhone && (typeof rawPhone !== 'string' || rawPhone.length === 0)) {
    itemState[phoneField] = pushPhone;
  }
  return itemState;
}
