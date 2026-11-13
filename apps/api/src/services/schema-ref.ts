/**
 * Resolves an aggregator schema file and the `profile_ref` that names it.
 *
 * `profile_ref` records which schema variant produced a stored `profile`.
 * Registration schemas vary per deployment, so each row names its own schema.
 *
 * The ref comes from the file that resolved, not from
 * `AGGREGATOR_NETWORK`/`AGGREGATOR_BRAND`. Lookup falls back to the shared
 * default when an override is missing, so an env-based ref could be wrong.
 *
 * Belongs to `@aggregator-dpg/api`.
 *
 * @module apps/api/src/services/schema-ref
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregatorSchemaRelPaths } from '@aggregator-dpg/network-config/paths';
import type { ConfigPathEnv } from '@aggregator-dpg/network-config/paths';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Candidate `config/` roots, covering source, compiled and container layouts. */
function configRoots(): string[] {
  return [
    // Source layout: apps/api/src/services → ../../../../config
    path.resolve(__dirname, '../../../../config'),
    // Compiled layout: apps/api/dist/services
    path.resolve(__dirname, '../../../../../config'),
    // Container layout when only `config/` is mounted at /app/config
    path.resolve(process.cwd(), 'config'),
    path.resolve(process.cwd(), '../../config'),
  ];
}

/** A schema file that exists on disk, plus the ref naming its variant. */
export interface ResolvedSchema {
  /** Absolute path to the resolved file. */
  path: string;
  /**
   * Variant id: `blue_dot/up-gzb/registration.v1` (brand),
   * `blue_dot/registration.v1` (network) or `registration.v1` (shared default).
   */
  ref: string;
}

/**
 * Turns a root-relative schema path into a `profile_ref`.
 *
 * `blue_dot/up-gzb/schemas/aggregator/registration.v1.json`
 *   → `blue_dot/up-gzb/registration.v1`
 *
 * @param rel - Root-relative path as produced by `aggregatorSchemaRelPaths`.
 * @returns The ref, with the `schemas/aggregator/` segment and `.json` removed.
 */
function refFromRelPath(rel: string): string {
  const withoutDir = rel.split(path.join('schemas', 'aggregator') + path.sep).join('');
  return withoutDir.replace(/\.json$/, '');
}

/**
 * Finds the most specific existing copy of an aggregator schema file.
 *
 * Specificity first, then root: a brand override in any root beats the shared
 * default in another.
 *
 * @param file - Bare schema file name, e.g. `registration.v1.json`.
 * @param env - Env-var bag; defaults to `process.env`. Tests pass their own object.
 * @returns The resolved file and its ref, or `null` when no candidate exists.
 */
export function resolveSchema(
  file: string,
  env: ConfigPathEnv = process.env,
): ResolvedSchema | null {
  for (const { path: candidate, rel } of schemaCandidates(file, env)) {
    if (existsSync(candidate)) return { path: candidate, ref: refFromRelPath(rel) };
  }
  return null;
}

/**
 * Every absolute path {@link resolveSchema} will try, in order.
 *
 * Exported so a caller can report which paths it tried.
 *
 * @param file - Bare schema file name, e.g. `registration.v1.json`.
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns Candidates, most specific first, each with its root-relative path.
 */
export function schemaCandidates(
  file: string,
  env: ConfigPathEnv = process.env,
): { path: string; rel: string }[] {
  const roots = configRoots();
  // Specificity first, then root, so a brand override in any root beats the shared default.
  return aggregatorSchemaRelPaths(file, env).flatMap((rel) =>
    roots.map((root) => ({ path: path.join(root, rel), rel })),
  );
}

/**
 * Returns the `profile_ref` for a schema file, or `null` when it cannot be
 * determined.
 *
 * `null` means the deployment's schema file is missing; callers should log it.
 *
 * @param file - Bare schema file name, e.g. `org-registration.v1.json`.
 * @param env - Env-var bag; defaults to `process.env`.
 * @returns The ref, or `null` if no copy of the file exists.
 */
export function resolveProfileRef(file: string, env: ConfigPathEnv = process.env): string | null {
  return resolveSchema(file, env)?.ref ?? null;
}
