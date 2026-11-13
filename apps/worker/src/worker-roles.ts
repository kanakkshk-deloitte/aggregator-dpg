/**
 * Worker role selection for the worker app.
 *
 * By default one process runs every consumer. `WORKER_ROLES` selects a subset,
 * for example to run the `file` parser in its own pod.
 *
 * @module @aggregator-dpg/worker
 */

/**
 * Selectable consumer roles.
 *
 * `cron` runs the link-metrics and watchdog ticks; `campaign` runs campaign jobs.
 */
export const WORKER_ROLES = ['file', 'row', 'finalise', 'cron', 'campaign'] as const;

/** A single worker role. */
export type WorkerRole = (typeof WORKER_ROLES)[number];

const ALL_ROLES: ReadonlySet<WorkerRole> = new Set(WORKER_ROLES);

/**
 * Parses the `WORKER_ROLES` env value into the set of roles this process runs.
 *
 * Unset, empty or `all` selects every role. Otherwise a comma-separated list;
 * case and whitespace are ignored, as are empty tokens.
 *
 * @param value - Raw `WORKER_ROLES` env value, if set.
 * @returns The set of roles to start. Always non-empty.
 * @throws {Error} If any token is not a known role.
 */
export function parseWorkerRoles(value?: string): Set<WorkerRole> {
  const raw = (value ?? '').trim();
  if (raw === '' || raw.toLowerCase() === 'all') {
    return new Set(WORKER_ROLES);
  }
  const roles = new Set<WorkerRole>();
  for (const token of raw.split(',')) {
    const role = token.trim().toLowerCase();
    if (role === '') continue;
    if (!ALL_ROLES.has(role as WorkerRole)) {
      throw new Error(`Unknown worker role: "${role}". Valid roles: ${WORKER_ROLES.join(', ')}.`);
    }
    roles.add(role as WorkerRole);
  }
  return roles.size === 0 ? new Set(WORKER_ROLES) : roles;
}

/**
 * Returns the roles this process does not run, for a boot-time warning.
 *
 * Every role must run somewhere in the fleet, or uploads and campaigns stall.
 * This only sees the current process.
 *
 * @param roles - Roles this process runs.
 * @returns The roles not covered here (empty when running all).
 */
export function missingRoles(roles: ReadonlySet<WorkerRole>): WorkerRole[] {
  return WORKER_ROLES.filter((r) => !roles.has(r));
}
