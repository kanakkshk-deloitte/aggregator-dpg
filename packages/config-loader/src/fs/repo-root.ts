/**
 * Shared filesystem probes for locating the monorepo `config/` tree.
 *
 * Used by the consent loader and the signals-roles loader. Works when called
 * from `apps/web`, `apps/api` or the repo root.
 *
 * @module @aggregator-dpg/config-loader/fs
 */

import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ConfigError } from '@aggregator-dpg/shared-primitives/errors';

/**
 * Returns true if the path exists and is readable.
 *
 * @param filePath - Absolute path to test.
 * @returns Whether the path can be accessed.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Determines the monorepo root by searching upward from `startDir` for a
 * directory that owns `config/schemas/aggregator/`.
 *
 * Tries three candidates relative to `startDir`:
 *   - `../../` (typical when cwd is `apps/web` or `apps/api`)
 *   - `../`
 *   - `.`
 *
 * @param startDir - Directory to start searching from (usually `process.cwd()`).
 * @param errorCode - Error code to use when no root is found.
 * @returns Absolute path to the directory that owns `config/`.
 * @throws {ConfigError} If no suitable root is found.
 */
export async function findRepoRoot(
  startDir: string,
  errorCode = 'CONFIG_ROOT_NOT_FOUND',
): Promise<string> {
  const candidates = [resolve(startDir, '../..'), resolve(startDir, '..'), resolve(startDir)];

  for (const candidate of candidates) {
    if (await fileExists(join(candidate, 'config', 'schemas', 'aggregator'))) {
      return candidate;
    }
  }

  throw new ConfigError(
    `Cannot locate monorepo root from "${startDir}": no config/schemas/aggregator/ directory found in [${candidates.join(', ')}]`,
    { code: errorCode, details: { startDir } },
  );
}
