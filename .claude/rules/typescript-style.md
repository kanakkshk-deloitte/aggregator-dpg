---
paths:
  - '**/*.ts'
  - '**/*.tsx'
---

# Rule: TypeScript Style

Applies to every TypeScript file in the repo. For cross-package service contracts read `interfaces.md` and `base-class-pattern.md` as well — they override the "plain data" guidance below.

## Type safety

- `strict` and `noUncheckedIndexedAccess` are on in `packages/tsconfig/base.json`. Never weaken either in a package-level `tsconfig.json`. `noUncheckedIndexedAccess` means `arr[0]` is `T | undefined` — handle the missing case, do not cast it away.
- No `any`. Use `unknown` plus narrowing for anything crossing a boundary: `catch (e)`, upstream responses, parsed JSON, config files.
- No `as` casts. A cast is an unchecked assertion. Validate with Zod and let the parsed result carry the type — the repo already uses Zod schemas for every service contract and config block.
- Use `===`, never `==`.

```typescript
// ✅
const parsed = ProfileSchema.safeParse(await res.json());
if (!parsed.success) return err(new ValidationError(parsed.error.message));

// ❌
const profile = (await res.json()) as Profile;
```

## Type design

- Plain data — DTOs, config shapes, props — is an `interface` or `type`, not a class.
- A cross-package **service contract** is an `abstract class`, per `interfaces.md`. That rule wins; it is about contracts, not data.
- Prefer string-literal unions over `enum`: `type Lifecycle = "draft" | "live" | "paused" | "retired"`.
- Derive types with `Pick`, `Omit`, `Partial`, `ReturnType` instead of restating fields. Drizzle inferred types from `db-schema` are the source of truth for table shapes.
- Model states as a discriminated union, not several optional fields that can contradict each other.

## Async

- `async`/`await`, not `.then()` chains.
- Every rejection is handled. Across a service boundary that means returning `Result<T, BaseError>` rather than throwing — see `error-handling.md`.
- Independent calls run in parallel with `Promise.all`, or `Promise.allSettled` when partial results are usable.
- Write `ids.map(id => getUser(id))`, not `ids.map(getUser)` — `map` passes the index and the array as extra arguments.

## Modules and immutability

- Named exports. Next.js special files (`page.tsx`, `layout.tsx`, `route.ts`, `error.tsx`, `loading.tsx`, `middleware.ts`) are the only default exports.
- Cross-package imports go through declared subpath exports (`./interface`, `./testing`), never a deep relative path.
- Never mutate an object or array that React renders from. Copy with spread, `map`, `filter`.
