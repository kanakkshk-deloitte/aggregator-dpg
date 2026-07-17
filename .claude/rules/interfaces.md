---
paths:
  - 'packages/*/src/interface.ts'
  - 'packages/*/src/*.ts'
  - 'apps/api/src/services/**'
  - 'apps/web/src/lib/oidc/**'
  - 'apps/web/src/lib/session/**'
---

# Interface Authoring Conventions

Reference for every service package in aggregator-dpg. Read this before opening a PR that adds or modifies a `src/interface.ts` file.

---

## 1. Abstract class, not TypeScript interface

**Rule:** Every service contract is an `abstract class`, not a `interface` or `type`.

```typescript
// ✅ Correct
export abstract class SignalStackClientBase {
  abstract fetchMembers(aggregatorId: AggregatorId): Promise<Result<Member[], BaseError>>;
}

// ❌ Wrong — TS interface cannot be used as a DI token or faked at runtime
export interface SignalStackClient {
  fetchMembers(aggregatorId: AggregatorId): Promise<Result<Member[], BaseError>>;
}
```

**Why:** Abstract classes can be extended by both real and in-memory implementations. They serve as dependency injection tokens at runtime. TypeScript interfaces are erased at compile time and cannot be used as runtime tokens or instanceof targets.

**Rules for abstract classes:**

- Every method is `abstract` — no default implementations in the base class.
- Method signatures in subclasses must match exactly: same parameter names, types, and return type.
- Never add, remove, or rename parameters in a concrete subclass.
- If a method is not applicable in a stub, return the correct empty/zero-value — never `throw new Error('not implemented')` in a production path.

---

## 2. Zod schema naming

| What                       | Convention                 | Example                                      |
| -------------------------- | -------------------------- | -------------------------------------------- |
| Schema for a single entity | `<Entity>Schema`           | `MemberSchema`                               |
| Schema for a request body  | `<Action>RequestSchema`    | `CreateLinkRequestSchema`                    |
| Schema for a response      | `<Action>ResponseSchema`   | `FetchMembersResponseSchema`                 |
| Config schema              | `configSchema` (lowercase) | `configSchema`                               |
| Inferred TypeScript type   | Same name without `Schema` | `type Member = z.infer<typeof MemberSchema>` |

```typescript
// ✅ Correct
export const MemberSchema = z.object({
  userId: z.string().min(1),
  name: z.string(),
  joinedAt: z.coerce.date(),
});
export type Member = z.infer<typeof MemberSchema>;

// ❌ Wrong — schema and type share name, or schema has no Schema suffix
export const Member = z.object({ ... });
export type TMember = { ... };
```

Only Zod schemas live in `src/interface.ts`. Do not import validation libraries other than `zod` into interface files — dep-cruiser enforces this.

**Exception — generic schema factories:** When a schema must be generic (e.g., `Paginated<T>`), a factory function is acceptable because Zod does not support generic schema constants. Use a lowercase function name ending with `schema` (not `Schema`):

```typescript
// ✅ Acceptable — factory required for generic T
export function paginatedSchema<T>(itemSchema: z.ZodType<T>) {
  return z.object({ items: z.array(itemSchema), total: z.number().int().nonnegative() });
}

// ❌ Wrong — lowercase factory used where a plain constant would suffice
export function memberSchema() { return z.object({ ... }); }
```

---

## 3. DTO naming

| What                    | Convention              | Example               |
| ----------------------- | ----------------------- | --------------------- |
| Paginated list response | `Paginated<Entity>`     | `Paginated<Member>`   |
| Filter / query params   | `<Entity>Filter`        | `MemberFilter`        |
| Create input            | `Create<Entity>Input`   | `CreateLinkInput`     |
| Update input            | `Update<Entity>Input`   | `UpdateMemberInput`   |
| Soft-deleted entity     | `<Entity>WithDeletedAt` | `MemberWithDeletedAt` |

Extend `Filter` from `@aggregator-dpg/shared-primitives/dto` rather than redefining pagination fields:

```typescript
import type { Filter } from '@aggregator-dpg/shared-primitives/dto';

export interface MemberFilter extends Filter {
  orgId?: OrgId;
  role?: 'seeker' | 'provider';
}
```

---

## 4. Error-return conventions — `Result<T, BaseError>` vs throw

**Rule:** All service boundary methods return `Result<T, BaseError>`. Never throw from a service method.

```typescript
// ✅ Correct — caller decides what to do with the error
abstract fetchMembers(aggregatorId: AggregatorId): Promise<Result<Member[], BaseError>>;

// ❌ Wrong — forces caller into try/catch, loses type information
abstract fetchMembers(aggregatorId: AggregatorId): Promise<Member[]>;
```

**When to use each error subclass:**

| Subclass          | Use for                                                   |
| ----------------- | --------------------------------------------------------- |
| `UpstreamError`   | External API failure, timeout, 5xx                        |
| `ConfigError`     | Missing or invalid config at startup                      |
| `AuthError`       | 401 / 403 from upstream or session invalid                |
| `ValidationError` | Malformed input before sending to upstream                |
| `DomainError`     | Business rule violation (not found, duplicate, invariant) |

**Constructing results:**

```typescript
import { ok, err } from '@aggregator-dpg/shared-primitives/result';
import { UpstreamError, DomainError } from '@aggregator-dpg/shared-primitives/errors';

// Success
return ok(members);

// Failure — upstream
return err(new UpstreamError('Signals Stack timed out', { cause: e, code: 'SIGNALS_TIMEOUT' }));

// Failure — not found
return err(new DomainError(`Member not found: ${userId}`, { code: 'NOT_FOUND' }));
```

**Consuming results:**

```typescript
import { match } from '@aggregator-dpg/shared-primitives/result';

const result = await client.fetchMembers(aggregatorId);
match(result, {
  onOk: (members) => {
    /* happy path */
  },
  onErr: (err) => {
    logger.error({
      operation: 'fetchMembers',
      status: 'failure',
      error: err.message,
      error_type: err.name,
    });
    // re-wrap or surface to caller
  },
});
```

**Exceptions to the rule:** constructors and module-level init functions may throw `ConfigError` since there is no caller to return a Result to.

---

## 5. Import constraints

`src/interface.ts` may only import from:

- `@aggregator-dpg/shared-primitives` — errors, IDs, Result, DTOs
- `zod` — schema definitions
- `node:*` — Node built-ins (e.g. `node:path` for type-only use)

All other imports are banned by dep-cruiser (`no-heavy-deps-in-interface` rule). Violations fail CI.

---

## 6. PR checklist for interface changes

Include these items in every PR that modifies `src/interface.ts`:

- [ ] Abstract class used (not TS `interface` or `type`)
- [ ] Every method is `abstract` — no default implementations
- [ ] All methods return `Result<T, BaseError>` (not bare throws)
- [ ] Zod schemas follow naming convention (`<Entity>Schema`, inferred type exported)
- [ ] DTOs extend shared primitives (`Filter`, `Paginated<T>`, `Timestamps`) where applicable
- [ ] Only `shared-primitives`, `zod`, `node:*` imported — `pnpm dep-check` passes locally
- [ ] In-memory fake and testing fake updated to match any signature changes
- [ ] Existing tests still pass: `pnpm --filter <package> test`
