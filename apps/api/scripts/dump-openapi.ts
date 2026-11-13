/**
 * Writes the OpenAPI spec to the repo root `openapi.json` (api app script; CI checks it for drift).
 * Sets the docs env before the config module loads, because swagger only registers when enabled.
 */
import { writeFile } from 'node:fs/promises';

process.env.API_REFERENCE_ENABLED = 'true';
process.env.API_REFERENCE_FORCE = 'true';
// Include the custom-role authoring routes so the spec lists every route the API can expose.
process.env.RBAC_CUSTOM_ROLES_ENABLED = 'true';
// Config requires DATABASE_URL. The script never connects (`pg.Pool` is lazy), so a placeholder is enough.
process.env.DATABASE_URL ??= 'postgres://localhost:5432/aggregator_spec_dump';
// Generic host, always overwritten so the committed spec is the same on every machine.
// To change it, edit this line, run `spec:dump`, and commit openapi.json.
process.env.PUBLIC_API_URL = 'https://aggregator.example.com';

const { buildApp } = await import('../src/app.js');
const app = await buildApp();
await app.ready();
const spec = app.swagger();
await writeFile(
  new URL('../../../openapi.json', import.meta.url),
  JSON.stringify(spec, null, 2) + '\n',
);
await app.close();
console.log(
  `openapi.json written (${Object.keys((spec as { paths: object }).paths).length} paths)`,
);
process.exit(0);
