/**
 * Unit tests for the `.env` bootstrap loader.
 *
 * `env.ts` is a side-effect-only module (no exports): on import it walks a
 * fixed list of candidate `.env` paths and loads the first one that exists.
 * `node:fs` and `dotenv` are mocked so no real file I/O happens and the
 * three candidate-resolution branches (first candidate, later candidate,
 * none found) are each exercised in isolation via `vi.resetModules()` +
 * dynamic re-import.
 *
 * @module @aggregator-dpg/api
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const existsSyncMock = vi.fn();
const loadDotenvMock = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
}));

vi.mock('dotenv', () => ({
  config: loadDotenvMock,
}));

describe('env bootstrap loader', () => {
  beforeEach(() => {
    vi.resetModules();
    existsSyncMock.mockReset();
    loadDotenvMock.mockReset();
  });

  it('loads the first candidate .env path that exists', async () => {
    existsSyncMock.mockReturnValue(true);
    await import('./env.js');
    expect(existsSyncMock).toHaveBeenCalledTimes(1);
    expect(loadDotenvMock).toHaveBeenCalledTimes(1);
    const calledPath = loadDotenvMock.mock.calls[0]?.[0]?.path as string;
    expect(calledPath.endsWith('.env')).toBe(true);
  });

  it('falls through to a later candidate when earlier ones are missing', async () => {
    existsSyncMock
      .mockReturnValueOnce(false) // ../.env
      .mockReturnValueOnce(false) // ../../.env
      .mockReturnValueOnce(true); // cwd/.env
    await import('./env.js');
    expect(existsSyncMock).toHaveBeenCalledTimes(3);
    expect(loadDotenvMock).toHaveBeenCalledTimes(1);
  });

  it('never calls dotenv when no candidate .env file exists', async () => {
    existsSyncMock.mockReturnValue(false);
    await import('./env.js');
    expect(existsSyncMock).toHaveBeenCalledTimes(3);
    expect(loadDotenvMock).not.toHaveBeenCalled();
  });
});
