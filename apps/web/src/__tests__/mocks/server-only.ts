/**
 * Test-only shim for the `server-only` package.
 *
 * Next.js's build pipeline recognises the bare `import 'server-only'` marker
 * and fails the build if such a module is ever pulled into a client bundle.
 * The package is never listed as an explicit dependency — Next provides it
 * internally — so Vite's resolver (used by Vitest) cannot resolve the bare
 * specifier at all. This empty module is aliased in `vitest.config.ts` so
 * `*.server.ts` files under test import successfully; it intentionally
 * performs no runtime check, since enforcing the client/server boundary is
 * Next's build-time job, not something a unit test needs to re-verify.
 *
 * @module apps/web/src/__tests__/mocks/server-only
 */
export {};
