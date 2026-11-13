/**
 * Dumps every route's access declaration to policy/rbac/edge/routes.json
 * (committed; CI drift-checks it). The edge policy (Envoy + OPA,
 * docs/rbac/rbac-edge-enforcement.md §3.1) decides each request from this
 * table, so it is generated from the routes' `config.rbac`, never hand-written.
 */
import { writeFile } from 'node:fs/promises';

// Register the full route surface, as the OpenAPI dump does: the custom-role
// authoring routes are a per-deploy registration detail, and the edge must
// know their declaration wherever they are enabled.
process.env.RBAC_CUSTOM_ROLES_ENABLED = 'true';
// Building the app never opens a connection (`pg.Pool` is lazy); the config
// schema only requires a value. `??=` so an exported value wins.
process.env.DATABASE_URL ??= 'postgres://localhost:5432/aggregator_routes_dump';

const { buildApp } = await import('../src/app.js');
const { exportRouteTable } = await import('../src/services/authz/index.js');
const app = await buildApp();
await app.ready();
const table = exportRouteTable();
await writeFile(
  new URL('../../../policy/rbac/edge/routes.json', import.meta.url),
  JSON.stringify(table, null, 2) + '\n',
);
await app.close();
console.log(`policy/rbac/edge/routes.json written (${table.routes.length} routes)`);
process.exit(0);
