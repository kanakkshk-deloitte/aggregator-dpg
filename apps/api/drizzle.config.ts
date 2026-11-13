import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration. Used by `db:generate`, `db:push`, `db:studio`
 * scripts to introspect and migrate the local Postgres instance.
 *
 * `DATABASE_URL` is required rather than defaulted: the URL carries
 * credentials, and a silent localhost fallback would let a mistyped env
 * point migrations at the wrong database.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL must be set to run drizzle-kit against a database.');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
