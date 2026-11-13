/**
 * Unit tests for the worker's `.env` bootstrap loader.
 *
 * `env.ts` runs entirely as import-time side effects (probe candidate paths,
 * load the first one found via dotenv). `node:fs` and `dotenv` are mocked so
 * no real filesystem/env mutation happens; the module is re-imported fresh
 * (via `vi.resetModules()`) for every scenario since it has no exported API
 * to reset.
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const existsSyncMock = vi.fn<(p: string) => boolean>();
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }));

const loadDotenvMock = vi.fn();
vi.mock('dotenv', () => ({ config: loadDotenvMock }));

describe('worker env bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    existsSyncMock.mockReset();
    loadDotenvMock.mockReset();
  });

  it('loads the second candidate .env path when the first is absent', async () => {
    // Candidates are checked in order: ../.env, ../../.env, cwd/.env.
    // Only the second probe returns true, proving both the ordering and
    // that the loop continues past a missing first candidate.
    let call = 0;
    existsSyncMock.mockImplementation(() => {
      call += 1;
      return call === 2;
    });

    await import('./env.js');

    expect(existsSyncMock).toHaveBeenCalledTimes(2);
    expect(loadDotenvMock).toHaveBeenCalledOnce();
    const loadedPath = loadDotenvMock.mock.calls[0]?.[0]?.path as string;
    expect(typeof loadedPath).toBe('string');
    expect(loadedPath.endsWith('.env')).toBe(true);
  });

  it('is a no-op when none of the candidate paths exist', async () => {
    existsSyncMock.mockReturnValue(false);

    await import('./env.js');

    expect(existsSyncMock).toHaveBeenCalledTimes(3);
    expect(loadDotenvMock).not.toHaveBeenCalled();
  });

  it('stops probing after the first match (does not check remaining candidates)', async () => {
    existsSyncMock.mockImplementation(() => true); // first candidate matches immediately

    await import('./env.js');

    expect(existsSyncMock).toHaveBeenCalledTimes(1);
    expect(loadDotenvMock).toHaveBeenCalledOnce();
  });
});
