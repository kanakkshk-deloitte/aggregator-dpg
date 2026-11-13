/**
 * Resolves a link's `registration_mode` key to its form shape (`@aggregator-dpg/api`).
 *
 * Modes are defined in network config under `aggregator.registration_modes`;
 * the DB column holds only the key. Unknown keys fall back to
 * `account_and_profile`, the full form.
 */
import type { ResolvedNetworkConfig } from '@aggregator-dpg/network-config/interface';
import {
  resolveSignalsCta,
  type SubmissionShape,
} from '@aggregator-dpg/network-config/signals-cta';

export type { SubmissionShape };

export function resolveSubmissionShape(mode: string, cfg: ResolvedNetworkConfig): SubmissionShape {
  const modes = cfg.aggregator.registration_modes ?? {};
  return modes[mode]?.submission_shape ?? 'account_and_profile';
}

export function isModeDeclared(mode: string, cfg: ResolvedNetworkConfig): boolean {
  const modes = cfg.aggregator.registration_modes ?? {};
  return Object.prototype.hasOwnProperty.call(modes, mode);
}

export function publicHintI18nKey(mode: string, cfg: ResolvedNetworkConfig): string | null {
  const modes = cfg.aggregator.registration_modes ?? {};
  return modes[mode]?.public_hint_i18n_key ?? null;
}

/**
 * Whether links in this mode offer the Signals UI hand-off.
 *
 * The rule lives in `@aggregator-dpg/network-config/signals-cta`, shared with
 * the web app. This passes the resolved submission shape, so an undeclared
 * mode behaves like its fallback shape.
 */
export function signalsCtaEnabled(mode: string, cfg: ResolvedNetworkConfig): boolean {
  const modes = cfg.aggregator.registration_modes ?? {};
  return resolveSignalsCta(modes[mode]?.signals_cta, resolveSubmissionShape(mode, cfg));
}
