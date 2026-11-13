/**
 * Unit tests for worker-role selection. Roles let a deployment run the
 * CPU-sensitive File Processor in its own process, isolated from the row /
 * finalise / cron workers (see ADR in the PR / docs/proposals).
 *
 * @module @aggregator-dpg/worker
 */

import { describe, it, expect } from 'vitest';
import { parseWorkerRoles, missingRoles, WORKER_ROLES } from './worker-roles.js';

describe('parseWorkerRoles', () => {
  it('defaults to ALL roles when unset', () => {
    expect(parseWorkerRoles(undefined)).toEqual(new Set(WORKER_ROLES));
  });

  it('defaults to ALL roles on empty / whitespace', () => {
    expect(parseWorkerRoles('   ')).toEqual(new Set(WORKER_ROLES));
  });

  it('treats the literal "all" as every role', () => {
    expect(parseWorkerRoles('all')).toEqual(new Set(WORKER_ROLES));
  });

  it('selects a single role', () => {
    expect(parseWorkerRoles('file')).toEqual(new Set(['file']));
  });

  it('selects multiple roles', () => {
    expect(parseWorkerRoles('file,row')).toEqual(new Set(['file', 'row']));
  });

  it('is case- and whitespace-insensitive and ignores empty tokens', () => {
    expect(parseWorkerRoles(' File , ROW , ')).toEqual(new Set(['file', 'row']));
  });

  it('throws on an unknown role (fail fast at boot)', () => {
    expect(() => parseWorkerRoles('file,bogus')).toThrowError(/unknown worker role/i);
  });

  it('defaults to ALL roles when every comma-separated token is empty', () => {
    // Not the same branch as raw === '' — raw is non-empty ("," survives the
    // initial trim) but every split token is blank, so the accumulator set
    // stays empty and the size===0 fallback kicks in.
    expect(parseWorkerRoles(',, ,')).toEqual(new Set(WORKER_ROLES));
  });
});

describe('missingRoles', () => {
  it('returns no missing roles when running all', () => {
    expect(missingRoles(parseWorkerRoles('all'))).toEqual([]);
  });

  it('reports the complement for a partial role set', () => {
    expect(missingRoles(parseWorkerRoles('file,row'))).toEqual(['finalise', 'cron', 'campaign']);
  });
});
