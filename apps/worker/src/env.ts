/**
 * Loads `apps/worker/.env` into `process.env` before any other module reads
 * config. Imported with side-effects as the first import of `main.ts` so a
 * vanilla `pnpm dev` works without shell exports (mirrors apps/api/src/env.ts).
 *
 * Production should rely on the orchestrator's environment injection — this
 * loader is a no-op when the file is absent.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const candidates = [
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(process.cwd(), '.env'),
];

for (const p of candidates) {
  if (existsSync(p)) {
    loadDotenv({ path: p });
    break;
  }
}
