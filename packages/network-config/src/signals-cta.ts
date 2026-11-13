/**
 * Default rule for the `signals_cta` flag, shared by the api and the web app.
 *
 * When a registration mode omits `signals_cta`, the Signals sign-in link is
 * shown on full-profile links only.
 *
 * This file must have no imports. The web app includes it in the client
 * bundle.
 *
 * @module @aggregator-dpg/network-config/signals-cta
 */

/** How much a registration link captures. Mirrors `submission_shape` in the YAML. */
export type SubmissionShape = 'account_only' | 'account_and_profile';

/**
 * Resolves a registration mode's effective `signals_cta` flag.
 *
 * @param explicit - The mode's declared `signals_cta`, or `undefined` when not set.
 * @param submissionShape - The submission shape the caller will render, not the raw YAML value.
 * @returns `explicit` when it is a boolean; otherwise true only for full-profile links.
 */
export function resolveSignalsCta(
  explicit: boolean | undefined,
  submissionShape: SubmissionShape,
): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return submissionShape === 'account_and_profile';
}
