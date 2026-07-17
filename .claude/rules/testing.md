---
paths:
  - 'packages/*/src/testing.ts'
  - 'packages/*/src/testing/**'
  - 'apps/api/src/services/**'
  - 'apps/web/src/lib/oidc/**'
  - 'apps/web/src/lib/session/**'
---

# Testing-Subpath Conventions

Reference for every service package in aggregator-dpg. Read this before opening a PR that adds or modifies `src/testing/`.

---

## 1. Fakes over mocks

**Rule:** Prefer an in-memory fake over a `vi.mock()` or `jest.mock()` stub.

```typescript
// ✅ Correct — import the fake from the ./testing subpath
import { ServiceFake } from '@aggregator-dpg/my-service/testing';

it('returns the saved item', async () => {
  const svc = new ServiceFake();
  svc.seed([{ id: 'item-1', name: 'Alpha', createdAt: new Date() }]);
  const result = await svc.findById('item-1');
  expect(result).toEqual({ ok: true, value: { id: 'item-1', name: 'Alpha' } });
});

// ❌ Wrong — vi.mock replaces the whole module; shape drift goes undetected
vi.mock('@aggregator-dpg/my-service/interface', () => ({
  ServiceBase: class {
    findById() {
      return { ok: true, value: {} };
    }
  },
}));
```

**Why fakes over mocks:**

| Concern     | Fake                                                      | Mock                                               |
| ----------- | --------------------------------------------------------- | -------------------------------------------------- |
| Shape drift | Compile-time — extends the real abstract class            | Silent — mock shape can diverge from the real impl |
| State       | Stateful — tests exercise real read-after-write behaviour | Stateless — each call is individually wired        |
| Behaviour   | Executes real result-wrapping and error paths             | Returns whatever you hard-code                     |
| Maintenance | Update fake when interface changes — one place            | Update every mock site — scattered                 |

**When mocks are acceptable:**

- Modules that are pure configuration (no behaviour to exercise).
- Third-party adapters where you cannot control the fake (e.g., a logger). Use `vi.spyOn` rather than replacing the whole module.
- Network requests already handled by `msw` or an equivalent interceptor layer.

---

## 2. Required surface

**Rule:** `ServiceFake` must implement every method declared in the abstract base class.

Because `ServiceFake extends InMemoryService extends ServiceBase`, TypeScript enforces this at compile time. Do not override methods to throw `'not implemented'` — return the correct empty/zero value instead.

```typescript
// ✅ Correct — InMemoryService already implements every method; ServiceFake inherits them
export class ServiceFake extends InMemoryService {
  seed(items: TemplateItem[]): void {
    for (const item of items) {
      this.store.set(item.id, item);
    }
  }
}

// ❌ Wrong — partial fake breaks tests that call delete()
export class ServiceFake extends ServiceBase {
  async findById(id: string) {
    return ok(this.store.get(id)!);
  }
  async save(item: TemplateItem) {
    return ok(item);
  }
  // delete not implemented — TypeError at runtime
}
```

---

## 3. `seed()` helper

**Rule:** Every `ServiceFake` exposes a `seed()` method that covers all entity types the fake manages.

```typescript
/**
 * Seeds the fake with pre-built items for test setup.
 *
 * Call before the test body, not inside the system under test.
 *
 * @param items - Items to insert before the test runs.
 */
seed(items: TemplateItem[]): void {
  for (const item of items) {
    this.store.set(item.id, item);
  }
}
```

Guidelines:

- `seed()` bypasses the public `save()` API — it sets the exact entity state the test needs.
- Seeds are idempotent: seeding the same `id` twice overwrites the first.
- If the service manages multiple entity types (e.g., users + sessions), add one `seed` overload or one method per entity.
- Never seed inside a real service method — `seed()` is test-only.

---

## 4. Test data builders

**Rule:** For any entity with more than 3 fields, provide a `build<Entity>()` helper alongside the fake.

```typescript
// src/testing/index.ts
import type { TemplateItem } from '../interface.js';

export function buildTemplateItem(overrides: Partial<TemplateItem> = {}): TemplateItem {
  return {
    id: 'item-default',
    name: 'Default Item',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}
```

Usage in tests:

```typescript
import { ServiceFake, buildTemplateItem } from '@aggregator-dpg/my-service/testing';

it('returns the saved item', async () => {
  const svc = new ServiceFake();
  const item = buildTemplateItem({ id: 'x-1', name: 'Custom' });
  svc.seed([item]);
  const result = await svc.findById('x-1');
  // …
});
```

Guidelines:

- Defaults must be **valid** — the builder's output must pass Zod validation.
- Use deterministic defaults (fixed date, sequential IDs) for snapshot-stable tests.
- Do not randomise defaults — flaky test ordering is hard to reproduce.
- Builders are exported from `./testing`, never from `./interface`.

---

## 5. In-memory vs `ServiceFake` — which to use

| Where                                                     | Use                                                               |
| --------------------------------------------------------- | ----------------------------------------------------------------- |
| Unit tests inside the **same package** (`src/__tests__/`) | `InMemoryService` directly — you own the impl                     |
| Unit tests in **other packages**                          | `ServiceFake` from the `./testing` subpath — public contract only |
| Integration tests                                         | Real implementation behind a test database or HTTP interceptor    |

Never import `InMemoryService` across package boundaries — it is an implementation detail. External consumers must go through `./testing`.

---

## 6. No real API calls in tests

**Rule:** Tests must not make real network requests or read from real databases.

- Use `ServiceFake` (or `msw` for HTTP handlers) to simulate all external dependencies.
- Assert on the `Result` value returned by the method under test, not on HTTP responses.
- If a test requires env vars (`DATABASE_URL`, `API_KEY`), it is an integration test — mark it with `.integration.test.ts` and exclude it from `pnpm -w test`.

---

## 7. PR checklist for `testing/` changes

Include these items in every PR that modifies `src/testing/`:

- [ ] `ServiceFake` extends the in-memory implementation (not `ServiceBase` directly)
- [ ] `seed()` helper covers all entity types the fake manages
- [ ] `build<Entity>()` helpers provided for entities with > 3 fields
- [ ] No real API calls or network access in tests
- [ ] `pnpm --filter <package> test` passes with coverage ≥ 70 %
