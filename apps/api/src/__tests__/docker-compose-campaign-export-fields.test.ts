/**
 * Regression test for aggregator-dpg#617 (final-review BLOCKING 2):
 * `CAMPAIGN_EXPORT_FIELDS` must be wired into the `api` service's environment
 * in every compose file, not only the `worker`'s. The API reads this same
 * variable (`apps/api/src/routes/campaign-export.ts`) to compute the export
 * audit row's `pii_fields` — if the container never receives it, the api
 * silently falls back to its Zod default (`contact`) regardless of what the
 * worker was actually configured to export, and the audit row understates a
 * `full` release.
 *
 * This is a plain-text scan rather than a YAML parse: no compose file is a
 * project dependency, and the string-level `service:` block boundary is
 * sufficient to prove the variable is declared in the right block.
 *
 * @module apps/api/__tests__/docker-compose-campaign-export-fields
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/api/src/__tests__ -> repo root is four levels up.
const repoRoot = path.resolve(here, '../../../..');

/**
 * Extracts the top-level-service YAML block named `serviceName` from a
 * docker-compose file's text, from its `  <name>:` header up to (but not
 * including) the next line at the same two-space service-name indentation.
 *
 * @param compose - The full compose file text.
 * @param serviceName - The service key to extract, e.g. `api`.
 * @returns The block's text (header line included).
 */
function extractServiceBlock(compose: string, serviceName: string): string {
  const lines = compose.split('\n');
  const headerRe = new RegExp(`^  ${serviceName}:\\s*$`);
  const start = lines.findIndex((l) => headerRe.test(l));
  if (start === -1) {
    throw new Error(`service "${serviceName}" not found in compose file`);
  }
  const nextServiceRe = /^  [A-Za-z0-9_-]+:\s*$/;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (nextServiceRe.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('CAMPAIGN_EXPORT_FIELDS reaches the api container (#617)', () => {
  it('docker-compose.yml: the api service declares CAMPAIGN_EXPORT_FIELDS', () => {
    const compose = readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
    const apiBlock = extractServiceBlock(compose, 'api');
    expect(apiBlock).toMatch(/CAMPAIGN_EXPORT_FIELDS:/);

    // Sanity: the worker also has it, and the two share the same env-var name
    // (not two independently-named/defaulted knobs).
    const workerBlock = extractServiceBlock(compose, 'worker');
    expect(workerBlock).toMatch(/CAMPAIGN_EXPORT_FIELDS:/);
  });

  it('local-setup/docker-compose.yml: the aggregator-api service declares CAMPAIGN_EXPORT_FIELDS', () => {
    const compose = readFileSync(path.join(repoRoot, 'local-setup', 'docker-compose.yml'), 'utf8');
    const apiBlock = extractServiceBlock(compose, 'aggregator-api');
    expect(apiBlock).toMatch(/CAMPAIGN_EXPORT_FIELDS:/);

    const workerBlock = extractServiceBlock(compose, 'aggregator-worker');
    expect(workerBlock).toMatch(/CAMPAIGN_EXPORT_FIELDS:/);
  });
});
