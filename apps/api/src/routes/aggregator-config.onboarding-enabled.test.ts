/**
 * Covers the first `AGGREGATOR_ONBOARDING_ENABLED` enforcement point (#637):
 * `GET /v1/aggregator-config` filters withheld registration modes out of the
 * `registration_modes` map it serves.
 *
 * This is the whole reason the admin create-link dropdown loses the option
 * without a single line of web change — `RegistrationLinksSection` renders
 * `Object.entries(cfg.registration_modes)` verbatim. So the filter is asserted
 * here, on the wire payload, rather than in the component.
 *
 * The env var is read live (per request), so these tests set it directly
 * instead of via `vi.hoisted` — that liveness is itself part of the contract.
 *
 * @module apps/api/routes/aggregator-config.onboarding-enabled.test
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { _setNetworkConfig } from '../services/network-config.js';
import { buildBlueDotConfig } from '@aggregator-dpg/network-config/testing';

/** The `registration_modes` slice of the response this file asserts on. */
interface ConfigBody {
  registration_modes: Record<
    string,
    { submission_shape: string; signals_cta: boolean; public_hint_i18n_key: string | null }
  >;
}

const ORIGINAL = process.env.AGGREGATOR_ONBOARDING_ENABLED;

async function fetchModes(app: FastifyInstance): Promise<ConfigBody['registration_modes']> {
  const res = await app.inject({ method: 'GET', url: '/v1/aggregator-config' });
  expect(res.statusCode).toBe(200);
  return (res.json() as ConfigBody).registration_modes;
}

describe('GET /v1/aggregator-config — AGGREGATOR_ONBOARDING_ENABLED filtering', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // The blue_dot fixture declares exactly two modes: voice (account_only,
    // signals_cta false) and form (account_and_profile, signals_cta true).
    _setNetworkConfig(buildBlueDotConfig());
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
    _setNetworkConfig(null);
    if (ORIGINAL === undefined) delete process.env.AGGREGATOR_ONBOARDING_ENABLED;
    else process.env.AGGREGATOR_ONBOARDING_ENABLED = ORIGINAL;
  });

  it('serves every declared mode when the var is unset (today’s response)', async () => {
    delete process.env.AGGREGATOR_ONBOARDING_ENABLED;
    const modes = await fetchModes(app);
    // Exact key set, not just "voice is present" — a filter that dropped an
    // unrelated mode would still pass a per-key assertion.
    expect(Object.keys(modes).sort()).toEqual(['form', 'voice']);
    expect(modes.voice?.submission_shape).toBe('account_only');
    expect(modes.voice?.signals_cta).toBe(false);
    expect(modes.voice?.public_hint_i18n_key).toBe('registration_mode.voice.hint');
    expect(modes.form?.submission_shape).toBe('account_and_profile');
    expect(modes.form?.signals_cta).toBe(true);
  });

  it('serves every declared mode when the var lists them all', async () => {
    process.env.AGGREGATOR_ONBOARDING_ENABLED = 'form,voice';
    expect(Object.keys(await fetchModes(app)).sort()).toEqual(['form', 'voice']);
  });

  it('omits voice when the allow-list is form only', async () => {
    process.env.AGGREGATOR_ONBOARDING_ENABLED = 'form';
    const modes = await fetchModes(app);
    expect(Object.keys(modes)).toEqual(['form']);
    expect(modes.voice).toBeUndefined();
  });

  it('keeps the surviving mode’s signals_cta resolution intact', async () => {
    process.env.AGGREGATOR_ONBOARDING_ENABLED = 'form';
    const modes = await fetchModes(app);
    // The filter must not disturb the `signals_cta` default resolution — that
    // boolean is what drives the public chooser / Signals CTA.
    expect(modes.form?.signals_cta).toBe(true);
    expect(modes.form?.submission_shape).toBe('account_and_profile');
  });

  it('omits form when the allow-list is voice only', async () => {
    // Proves the filter follows the allow-list rather than hardcoding `voice`
    // as the droppable one.
    process.env.AGGREGATOR_ONBOARDING_ENABLED = 'voice';
    const modes = await fetchModes(app);
    expect(Object.keys(modes)).toEqual(['voice']);
    expect(modes.voice?.signals_cta).toBe(false);
  });

  it('serves an empty map when the allow-list matches no declared mode', async () => {
    // Deliberate: an all-typo value does NOT fail open to "everything
    // enabled". The api logs an error for it (see the network-config tests);
    // the response is honestly empty.
    process.env.AGGREGATOR_ONBOARDING_ENABLED = 'frm';
    expect(await fetchModes(app)).toEqual({});
  });

  it('tolerates whitespace and casing in the env value', async () => {
    process.env.AGGREGATOR_ONBOARDING_ENABLED = '  FORM  ';
    expect(Object.keys(await fetchModes(app))).toEqual(['form']);
  });
});
