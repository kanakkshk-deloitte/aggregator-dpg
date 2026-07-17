---
paths:
  - 'packages/*/src/interface.ts'
  - 'packages/*/src/*.ts'
  - 'apps/api/src/services/**'
  - 'apps/web/src/lib/oidc/**'
  - 'apps/web/src/lib/session/**'
---

# Rule: Base Class Pattern

Every core component must define an abstract class **before** any concrete implementation.

- Abstract class declares required methods with signatures and return types.
- Concrete implementations extend the abstract class and implement every method.
- No concrete implementation may be used by another module unless it extends the abstract class.

```typescript
// packages/db/src/interface.ts
export abstract class RepositoryBase<T> {
  abstract findById(id: string): Promise<T | null>;
  abstract save(entity: T): Promise<T>;
  abstract delete(id: string): Promise<void>;
}
```

All classes derived from an abstract class must:

- Implement **every** method declared — no partial implementations.
- Preserve the exact method signature. Do not add, remove, or rename parameters in subclasses.
- Return the same output type and structure the abstract class documents. Different implementations must not return different shapes.

If a method is not applicable in a stub, return the correct empty/default value — not `throw new Error('not implemented')` in production paths.

Every function must explicitly handle edge conditions. Do not assume inputs are well-formed.

| Condition                                     | Expected behaviour                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| Empty string input                            | Return a structured empty result, not an error                                |
| `undefined` / `null` for a required parameter | Throw a descriptive `TypeError` or `ValueError` immediately                   |
| Missing key in an object                      | Use optional chaining (`?.`) or nullish coalescing (`??`) with a safe default |
| Empty array or zero results                   | Return an empty result with a clear status field                              |
| Unexpected type from upstream                 | Log the type mismatch and return a structured error response                  |

Functions must fail safely — never crash the caller with an unhandled exception.

Each package exposes a defined public interface only via subpath exports.

- Other packages interact exclusively through the `./interface` subpath export.
- Internal helpers must not be imported by other packages.
- Prefix internal functions/classes with `_` or keep them unexported to signal they are not public.

```typescript
// Correct — import via interface subpath
import { DBService } from '@aggregator-dpg/db/interface';

// Wrong — never reach into impl internals
import { _buildQueryClause } from '@aggregator-dpg/db/postgres';
```
