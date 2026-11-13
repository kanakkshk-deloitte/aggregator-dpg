/**
 * Runtime configuration for the schema-driven form widgets (address
 * autocomplete + the reference/college picker).
 *
 * Has no `next/*` imports, so it is unit-testable.
 *
 * `getFormRuntimeConfig()` reads `process.env`; call it only from server code.
 * Client components get the value from `FormRuntimeConfigProvider`. Values are
 * not `NEXT_PUBLIC_*`, so they can change without a rebuild.
 *
 * Names and defaults match the Signals UI's `VITE_*` equivalents.
 *
 * @module apps/web/lib/form-runtime-config
 */

/**
 * Values the form widgets need at runtime.
 *
 * With no values set, widgets use plain text inputs and the key-less Photon
 * geocoder.
 */
export interface FormRuntimeConfig {
  /**
   * Google Maps JS API browser key. Absent means Photon is used. Restrict it
   * by HTTP referrer in the Google console.
   */
  googleMapsApiKey?: string;
  /** Override for the Photon endpoint. Absent means Photon's public host. */
  photonUrl?: string;
  /**
   * Upper-case ISO 3166-1 alpha-2 country that address autocomplete is
   * restricted to, e.g. `IN`. Absent means no restriction.
   */
  geoCountry?: string;
  /**
   * Region code for the college dataset the reference picker loads
   * (`colleges-<code>.json`). Defaults to `ka`, as in Signals.
   */
  collegeDataset: string;
  /**
   * Base URL for the reference datasets. Empty means the app's own
   * `/reference/`, where a deployment mounts its ConfigMap. The datasets are
   * not in this repo. A remote host must allow CORS, since the browser fetches
   * it directly.
   */
  referenceBaseUrl?: string;
}

/** Region used when `COLLEGE_DATASET` is unset. Must match the Helm chart default. */
export const DEFAULT_COLLEGE_DATASET = 'ka';

/**
 * Trims an environment value and treats blank as absent.
 *
 * Helm renders an unset value as `""`, which must not count as configured.
 *
 * @param raw - The raw environment value, if any.
 * @returns The trimmed value, or `undefined` when unset or blank.
 */
function cleaned(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalises a country setting to an upper-case ISO 3166-1 alpha-2 code.
 *
 * @param raw - The raw environment value, if any.
 * @returns The code, or `undefined` when unset, blank, or not two letters.
 */
function countryCode(raw: string | undefined): string | undefined {
  const code = cleaned(raw)?.toUpperCase();
  return code && /^[A-Z]{2}$/.test(code) ? code : undefined;
}

/**
 * Resolves the form widgets' runtime configuration from the environment.
 *
 * Server-only. Publish the result through {@link FormRuntimeConfigProvider}.
 *
 * @returns The resolved configuration, with `collegeDataset` always populated.
 */
export function getFormRuntimeConfig(): FormRuntimeConfig {
  const googleMapsApiKey = cleaned(process.env.GOOGLE_MAPS_API_KEY);
  const photonUrl = cleaned(process.env.PHOTON_URL);
  const geoCountry = countryCode(process.env.GEO_COUNTRY);
  const referenceBaseUrl = cleaned(process.env.REFERENCE_BASE_URL);
  return {
    ...(googleMapsApiKey ? { googleMapsApiKey } : {}),
    ...(photonUrl ? { photonUrl } : {}),
    ...(geoCountry ? { geoCountry } : {}),
    ...(referenceBaseUrl ? { referenceBaseUrl } : {}),
    collegeDataset: cleaned(process.env.COLLEGE_DATASET) ?? DEFAULT_COLLEGE_DATASET,
  };
}
