/**
 * In-memory identity store for tests (`@aggregator-dpg/api`). Same outcomes as
 * the Postgres adapter: one login per provider per account, one account per
 * external login, never overwritten.
 */

import { IdentityStoreBase, type IdentityStoreResult, type LinkOutcome } from './interface.js';

/** One stored link. */
export interface IdentityLink {
  userId: string;
  provider: string;
  subject: string;
}

/** In-memory {@link IdentityStoreBase}. */
export class InMemoryIdentityStore extends IdentityStoreBase {
  protected readonly links: IdentityLink[] = [];

  /** Known account types (optional; see {@link registerAccount}). */
  protected readonly accountTypes = new Map<string, 'admin' | 'coordinator'>();

  /** Test helper — declares an account and its type, so `userType` checks apply. */
  registerAccount(userId: string, type: 'admin' | 'coordinator'): void {
    this.accountTypes.set(userId, type);
  }

  link(
    userId: string,
    provider: string,
    subject: string,
    userType?: 'admin' | 'coordinator',
  ): Promise<IdentityStoreResult<LinkOutcome>> {
    const known = this.accountTypes.get(userId);
    if (userType && known && known !== userType) {
      return Promise.resolve({
        ok: false,
        error: { code: 'NOT_LINKABLE', message: 'wrong account type' },
      });
    }
    const mine = this.links.find((l) => l.userId === userId && l.provider === provider);
    if (mine) {
      return Promise.resolve(
        mine.subject === subject
          ? { ok: true, value: 'already' }
          : { ok: false, error: { code: 'MISMATCH', message: 'different subject' } },
      );
    }
    if (this.links.some((l) => l.provider === provider && l.subject === subject)) {
      return Promise.resolve({ ok: false, error: { code: 'DUPLICATE', message: 'subject taken' } });
    }
    this.links.push({ userId, provider, subject });
    return Promise.resolve({ ok: true, value: 'linked' });
  }

  subjectOf(userId: string, provider: string): Promise<IdentityStoreResult<string | null>> {
    const l = this.links.find((x) => x.userId === userId && x.provider === provider);
    return Promise.resolve({ ok: true, value: l?.subject ?? null });
  }

  userOf(provider: string, subject: string): Promise<IdentityStoreResult<string | null>> {
    const l = this.links.find((x) => x.provider === provider && x.subject === subject);
    return Promise.resolve({ ok: true, value: l?.userId ?? null });
  }

  /** Test inspector — every stored link. */
  all(): IdentityLink[] {
    return [...this.links];
  }
}
