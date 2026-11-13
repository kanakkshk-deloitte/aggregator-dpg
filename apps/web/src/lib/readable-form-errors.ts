/**
 * Readable RJSF validation errors (`apps/web`), shared by every
 * schema-driven form.
 *
 * @module apps/web/src/lib/readable-form-errors
 */

import type { RJSFValidationError } from '@rjsf/utils';
import {
  describeSchemaIssue,
  formatFieldErrors,
} from '@aggregator-dpg/network-config/field-errors';

/**
 * Rewrites RJSF's validation errors into the wording the participant sees.
 *
 * Each message comes from the shared `field-errors` rules, so a failed URL
 * reads "Please enter a valid web address." and a failed pattern never shows
 * its regex. The banner text (`stack`) is prefixed with the field's title, e.g.
 * `Website: Please enter a valid web address.` — the same sentence the API
 * returns when the server catches it.
 *
 * @param errors - RJSF's errors for the current form data.
 * @param schema - The schema the form validated against (titles, URL marker).
 * @returns The same errors with readable `message` and `stack`.
 */
export function readableFormErrors(
  errors: RJSFValidationError[],
  schema: unknown,
): RJSFValidationError[] {
  return errors.map((e) => {
    const params = (e.params ?? {}) as Record<string, unknown>;
    // RJSF's `property` (".address.city") already ends with the missing key
    // for a `required` error; `describeSchemaIssue` appends it again itself.
    const segments = (e.property ?? '').split('.').filter(Boolean);
    if (e.name === 'required' && segments.at(-1) === params['missingProperty']) segments.pop();
    if (e.name === 'additionalProperties' && segments.at(-1) === params['additionalProperty']) {
      segments.pop();
    }
    const d = describeSchemaIssue(
      {
        ...(e.name !== undefined ? { keyword: e.name } : {}),
        instancePath: segments.map((seg) => `/${seg}`).join(''),
        params,
        ...(e.message !== undefined ? { message: e.message } : {}),
      },
      schema,
    );
    return { ...e, message: d.message, stack: formatFieldErrors([d]) };
  });
}
