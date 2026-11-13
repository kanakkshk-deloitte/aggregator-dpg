/**
 * Covers the `SIGNALS_UI_URLS` warning-emit loop in `buildApp`.
 *
 * `config.ts` parses the env var at module load, before any logger exists, so
 * it returns its warnings as data and `app.ts` is responsible for actually
 * emitting them once Fastify's logger is up. That hand-off is the only thing
 * standing between a typo'd env var and a silently disabled hand-off, so it is
 * tested directly: `config.js` is mocked to supply the warnings and the pino
 * stream is captured to prove they reach the log.
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
    'SIGNALS_UI_URLS: skipping domain "provider" — value is not a valid URL',
    'SIGNALS_UI_URLS: skipping entry with no "=" separator: "justtext"',
  ],
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof ConfigModule>('./config.js');
  return { ...actual, signalsUiUrlWarnings: WARNINGS };
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

describe('buildApp SIGNALS_UI_URLS warning emit', () => {
  it('logs one structured warning per skipped entry', async () => {
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
      .filter((l) => l.operation === 'config.parseSignalsUiUrls');

    expect(emitted).toHaveLength(WARNINGS.length);
    // Warn level, not info — a misconfigured env must stand out in cluster logs.
    expect(emitted.every((l) => l.level === 40)).toBe(true);
    expect(emitted.every((l) => l.status === 'skipped')).toBe(true);
    // The message must carry the parser's own text, which names the offending
    // entry; a generic "config problem" line would not be actionable.
    expect(emitted.map((l) => l.msg)).toEqual(WARNINGS);
  });
});
