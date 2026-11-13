---
paths:
  - 'apps/web/src/app/**'
  - 'apps/web/src/components/**'
  - 'apps/web/src/lib/**'
  - 'apps/web/middleware.ts'
---

# Rule: Next.js App Router

The web app is Next.js 15 (App Router) and its own BFF. Read `apps/web/CLAUDE.md` for the repo-specific session, auth and schema-rendering patterns; this rule is the framework baseline underneath them.

## Structure

- `page.tsx` stays thin: resolve params, fetch, compose components, return.
- Reusable UI in `src/components/`, logic in `src/lib/`, data access in its own module — never an upstream call inline in a component.
- Shared chrome belongs in a layout, not repeated per page.
- Import through `@/`.

## Routing and navigation

- `Link` for every internal navigation. A bare `<a>` reloads the page and drops client state.
- `params` and `searchParams` are untrusted input from the URL. Validate and convert types explicitly, then fail closed (`notFound()` / a typed error), never pass a raw string into an upstream call.
- In Next.js 15 `params` and `searchParams` are Promises — `await` them.

```tsx
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  ...
}
```

## Server vs Client Components

- Default to Server Components. They keep tokens, session reads and upstream calls off the browser and ship no JavaScript.
- `"use client"` goes on the smallest leaf that needs interactivity. Marking a layout or page pulls its whole subtree into the bundle.
- Resolve configuration on the server and pass it down as props or through a provider — the pattern `apps/web/CLAUDE.md` describes for form runtime config. Do not reach for a `NEXT_PUBLIC_*` variable to avoid the plumbing.

## Security and validation

- Server Actions and Route Handlers are public HTTP endpoints. Validate every input and re-check authorisation inside the handler. A hidden field, a disabled button or a non-rendered nav item is not a control.
- Never pass a secret into a Client Component — it lands in the browser bundle. Only `NEXT_PUBLIC_*` reaches the browser, so never put a secret behind that prefix.
- Anonymous flows use the service-account token helper, authenticated flows use `callApi`. Keep the split — see `apps/web/CLAUDE.md`.

## Performance

- Use `loading.tsx` and `<Suspense>` to stream, so one slow upstream call holds back one section rather than the whole page.
