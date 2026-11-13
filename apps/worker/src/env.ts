/**
 * Loads `apps/worker/.env` into `process.env` before config is read.
 *
 * Must be the first import of `main.ts`. No-op when no `.env` file exists.
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
