/**
 * Unit tests for the token `roles` claim sweep and reconcile
 * (`@aggregator-dpg/api`; docs/rbac/rbac-edge-enforcement.md §3.2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _setRbacRuntime } from '../runtime.js';
import {
  reconcileTokenRoles,
  startTokenRolesRepair,
  stopTokenRolesRepair,
  sweepTokenRoles,
  type SweepDeps,
} from '../token-roles-sweep.js';
import type { TokenRolesOutcome } from '../token-roles.js';

const NOW = 1_800_000_000_000;

afterEach(() => {
  stopTokenRolesRepair();
  vi.restoreAllMocks();
});

/** Recording fake dependencies. */
function fakeDeps(over: Partial<SweepDeps> = {}, outcome: TokenRolesOutcome = 'synced') {
  const synced: Array<[string, string]> = [];
  const windows: Array<[number, number]> = [];
  const deps: SweepDeps = {
    listUserIds: async () => ['a', 'b', 'c'],
    listExpired: async (from, to) => {
      windows.push([from.getTime(), to.getTime()]);
      return [];
    },
    popDirty: async () => [],
    once: async (_name, _ttl, fn) => {
      await fn();
      return true;
    },
    sync: async (id, reason) => {
      synced.push([id, reason]);
      return outcome;
    },
    now: () => NOW,
    ...over,
  };
  return { deps, synced, windows };
}

describe('sweepTokenRoles', () => {
  it('retries marked users and re-syncs users whose role expired, each once', async () => {
    const { deps, synced } = fakeDeps({
      popDirty: async () => ['d1', 'd2', 'd1'],
      listExpired: async () => ['e1', 'd2', 'e1'],
    });
    expect(await sweepTokenRoles(60_000, deps)).toBe('ran');
    expect(synced).toEqual([
      ['d1', 'retry'],
      ['d2', 'retry'],
      ['e1', 'expired'],
    ]);
  });

  it('looks back twice the interval, so a late tick still catches an expiry', async () => {
    const { deps, windows } = fakeDeps();
    await sweepTokenRoles(60_000, deps);
    expect(windows).toEqual([[NOW - 120_000, NOW]]);
  });

  it('does nothing when another replica holds the lock', async () => {
    const { deps, synced } = fakeDeps({
      popDirty: async () => ['d1'],
      once: async () => false,
    });
    expect(await sweepTokenRoles(60_000, deps)).toBe('skipped');
    expect(synced).toHaveLength(0);
  });

  it('never throws when a dependency fails', async () => {
    const { deps } = fakeDeps({
      listExpired: async () => {
        throw new Error('db down');
      },
    });
    expect(await sweepTokenRoles(60_000, deps)).toBe('failed');
  });
});

describe('reconcileTokenRoles', () => {
  it('re-syncs every user', async () => {
    const { deps, synced } = fakeDeps();
    expect(await reconcileTokenRoles(deps)).toBe('ran');
    expect(synced).toEqual([
      ['a', 'reconcile'],
      ['b', 'reconcile'],
      ['c', 'reconcile'],
    ]);
  });

  it('syncs a few at a time and covers every user', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `u${i}`);
    let inFlight = 0;
    let peak = 0;
    const { deps } = fakeDeps({
      listUserIds: async () => ids,
      sync: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return 'synced';
      },
    });
    expect(await reconcileTokenRoles(deps)).toBe('ran');
    expect(peak).toBeLessThanOrEqual(5);
  });

  it('does nothing when another replica holds the lock', async () => {
    const { deps, synced } = fakeDeps({ once: async () => false });
    expect(await reconcileTokenRoles(deps)).toBe('skipped');
    expect(synced).toHaveLength(0);
  });

  it('never throws when listing users fails', async () => {
    const { deps } = fakeDeps({
      listUserIds: async () => {
        throw new Error('db down');
      },
    });
    expect(await reconcileTokenRoles(deps)).toBe('failed');
  });
});

describe('startTokenRolesRepair', () => {
  it('starts no timer with RBAC off', () => {
    _setRbacRuntime(null);
    const spy = vi.spyOn(globalThis, 'setInterval');
    startTokenRolesRepair();
    expect(spy).not.toHaveBeenCalled();
  });
});
