/**
 * Database access for the instance-upgrade tool (`@aggregator-dpg/api`): instance
 * facts, role and session checks, and the runner for the operator SQL
 * (`check_id | category | n` rows). Uses only the pool or connection it is given.
 */

import { readFile } from 'node:fs/promises';
import type { Queryable } from '../db/migrate-core.js';

/** Instance facts shown to the operator before anything is written. */
export interface InstanceFacts {
  systemIdentifier: string;
  database: string;
  host: string | null;
  user: string;
  serverVersion: string;
}

/**
 * Reads the facts that identify the connected database.
 *
 * @param pool - Postgres pool.
 * @returns The server id, database, host, role and version.
 */
export async function readInstanceFacts(pool: Queryable): Promise<InstanceFacts> {
  const r = await pool.query<{
    sid: string;
    db: string;
    host: string | null;
    usr: string;
    ver: string;
  }>(`SELECT (SELECT system_identifier::text FROM pg_control_system()) AS sid,
             current_database() AS db, inet_server_addr()::text AS host,
             current_user AS usr, current_setting('server_version') AS ver`);
  const row = r.rows[0];
  if (!row) throw new Error('instance facts unavailable');
  return {
    systemIdentifier: row.sid,
    database: row.db,
    host: row.host,
    user: row.usr,
    serverVersion: row.ver,
  };
}

/**
 * Whether the session's role can act as the owner of the coordinator table
 * (`users`, or `aggregators` before 0027). The migrations `SET LOCAL ROLE` to
 * that owner and refuse otherwise.
 *
 * @param pool - Postgres pool.
 * @returns `true` when the role is the owner or a member of it.
 */
export async function canActAsOwner(pool: Queryable): Promise<boolean> {
  const r = await pool.query<{ ok: boolean | null }>(
    `SELECT pg_has_role(current_user, pg_get_userbyid(c.relowner), 'MEMBER') AS ok
       FROM pg_class c
      WHERE c.oid = coalesce(to_regclass('public.users'), to_regclass('public.aggregators'))`,
  );
  return r.rows[0]?.ok === true;
}

/** Other sessions connected to the database, by application name. */
export interface OtherSession {
  applicationName: string;
  count: number;
  /** A session of this tool (`train…`), from another operator or a killed run. */
  tool: boolean;
}

/**
 * Lists the other sessions on the current database. Pods must be scaled to zero.
 * Sessions of other roles may show NULL names without `pg_read_all_stats`; they
 * are still counted. Background processes are not counted.
 *
 * @param pool - Postgres pool or connection.
 * @returns One entry per application name; empty when alone.
 */
export async function otherSessions(pool: Queryable): Promise<OtherSession[]> {
  const r = await pool.query<{ app: string; n: string; tool: boolean }>(
    `SELECT coalesce(nullif(application_name, ''), '(unnamed)') AS app, count(*)::text AS n,
            coalesce(application_name, '') LIKE 'train%' AS tool
       FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND usesysid IS NOT NULL
        AND (backend_type = 'client backend' OR backend_type IS NULL)
      GROUP BY 1, 3 ORDER BY 1`,
  );
  return r.rows.map((x) => ({ applicationName: x.app, count: Number(x.n), tool: x.tool }));
}

/** One row of an operator check script. */
export interface CheckRow {
  checkId: string;
  /** `blocker` / `gate` must be 0; `info` is reported only. */
  category: 'blocker' | 'gate' | 'info';
  n: number;
}

/** Whether a row stops the operation. */
export function isFailing(row: CheckRow): boolean {
  return row.category !== 'info' && row.n > 0;
}

/**
 * Splits a psql script into statements. Drops `\` meta lines and `--` comment
 * lines. A statement ends at `;` at a line end, outside quotes and dollar-quoted
 * bodies. Not supported, and unused by the operator scripts: `/* … *\/`
 * comments, `E'\''` escapes, and a quote inside a trailing `--` comment.
 *
 * @param script - The script text.
 * @returns The statements, in order.
 */
export function sqlStatements(/* NOSONAR typescript:S3776 */ script: string): string[] {
  const body = script
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('\\') && !l.trimStart().startsWith('--'))
    .join('\n');
  const statements: string[] = [];
  let current = '';
  let dollarTag: string | null = null;
  let inString = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (dollarTag) {
      if (body.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
      } else current += ch;
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(body.slice(i))?.[0];
      if (tag) {
        dollarTag = tag;
        current += tag;
        i += tag.length - 1;
        continue;
      }
    } else if (ch === ';' && /^[ \t]*(\n|$)/.test(body.slice(i + 1))) {
      statements.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  statements.push(current);
  return statements.map((x) => x.trim()).filter((x) => x.length > 0);
}

/**
 * Runs an operator check script and returns its `check_id | category | n` rows.
 * Statements without a `check_id` (setup such as TEMP views) run but add no row.
 *
 * @param client - The upgrade transaction or a read session.
 * @param file - Path to the script.
 * @returns The rows, in script order.
 */
export async function runChecks(client: Queryable, file: string): Promise<CheckRow[]> {
  const rows: CheckRow[] = [];
  for (const stmt of sqlStatements(await readFile(file, 'utf8'))) {
    const r = await client.query<{ check_id?: string; category?: string; n?: string }>(stmt); // NOSONAR typescript:S9382 — statements run in order
    for (const row of r.rows ?? []) {
      if (row.check_id === undefined) continue;
      const category =
        row.category === 'info' || row.category === 'blocker' ? row.category : 'gate';
      rows.push({ checkId: row.check_id, category, n: Number(row.n) });
    }
  }
  return rows;
}
