/**
 * Covers the `AGGREGATOR_ONBOARDING_ENABLED` warning-emit loop in `buildApp`.
 *
 * `config.ts` parses the env var at module load, before any logger exists, so
 * it returns its warnings as data and `app.ts` emits them once Fastify's
 * logger is up. Without that hand-off a duplicate entry — or a value set to
 * nothing but separators, which withholds every registration mode — is
 * completely silent. Mirrors `app.signals-ui-url-warnings.test.ts`: mock
 * `config.js` to supply the warnings, capture the pino stream, assert they
 * land.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type * as ConfigModule from './config.js';
import type * as LoggerModule from './logger.js';

const { lines, WARNINGS } = vi.hoisted(() => ({
  lines: [] as string[],
  WARNINGS: [
    'AGGREGATOR_ONBOARDING_ENABLED: duplicate entry "form" — listing it once is enough',
    'AGGREGATOR_ONBOARDING_ENABLED is set but names no capability — no registration mode will be offered. Unset the variable to enable all of them.',
  ],
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof ConfigModule>('./config.js');
  return { ...actual, onboardingEnabledWarnings: WARNINGS };
});

// Point the shared pino options at an in-memory sink so the lines Fastify's
// own logger writes during buildApp can be read back. `stream` is a Fastify
// logger option rather than a pino one, hence the cast.
vi.mock('./logger.js', async () => {
  const actual = await vi.importActual<typeof LoggerModule>('./logger.js');
  const sink = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return {
    ...actual,
    loggerOptions: { ...actual.loggerOptions, level: 'warn', stream: sink } as never,
  };
});

const { buildApp } = await import('./app.js');

describe('buildApp AGGREGATOR_ONBOARDING_ENABLED warning emit', () => {
  it('logs one structured warning per parse warning', async () => {
    let app: FastifyInstance | undefined;
    try {
      app = await buildApp();
      await app.ready();
    } finally {
      await app?.close();
    }

    const emitted = lines
      .map(
        (l) =>
          JSON.parse(l) as { level: number; operation?: string; status?: string; msg?: string },
      )
      .filter((l) => l.operation === 'config.parseOnboardingEnabled');

    expect(emitted).toHaveLength(WARNINGS.length);
    // Warn level, not info — a misconfigured env must stand out in cluster logs.
    expect(emitted.every((l) => l.level === 40)).toBe(true);
    expect(emitted.every((l) => l.status === 'skipped')).toBe(true);
    // The parser's own text, which names the offending value; a generic
    // "config problem" line would not be actionable.
    expect(emitted.map((l) => l.msg)).toEqual(WARNINGS);
  });
});
