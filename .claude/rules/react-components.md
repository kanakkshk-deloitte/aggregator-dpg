---
paths:
  - 'apps/web/src/**/*.tsx'
  - 'apps/web/src/hooks/**'
---

# Rule: React Components

Applies to the web portal. Read `nextjs-app-router.md` with this — the data-fetching rules only make sense as a pair.

## Components

- Small and single-purpose. A component that fetches, filters, sorts and renders is three components.
- Props get a typed interface. No inline `any`, no untyped spread.
- List items need a stable, unique `key` — a real id. An array index is only safe when the list never reorders, never has items inserted, and is never filtered.

## State and props

- Never mutate state or props. Build a new value.
- Use the functional setter when the next value depends on the previous one: `setCount(prev => prev + 1)`. Updates batch, and the direct form reads a stale value.
- Derive during render instead of mirroring into state. A value computed from props is always correct; a copy in state goes stale.
- Lift state to the nearest common parent when siblings need it.
- Avoid deep prop drilling. Use an existing context (`auth-context`, `FormRuntimeConfigProvider`) or resolve the value on the server and pass it in.

```tsx
// ✅ derived
const visible = items.filter((i) => i.lifecycle !== 'retired');

// ❌ duplicated in state, needs an effect to stay in sync
const [visible, setVisible] = useState(items);
useEffect(() => setVisible(items.filter((i) => i.lifecycle !== 'retired')), [items]);
```

## Hooks and effects

- Rules of hooks: top level of a component or another hook only. Never in a condition, loop or callback.
- Keep effects minimal. Most things written as an effect are an event handler or a derived value. An effect is for synchronising with something outside React.
- Return a cleanup function from any effect that subscribes, opens a socket, or sets a timer.
- Do not add `useMemo` or `useCallback` by default. Add one when a measurement shows a cost, or when the value must stay referentially stable for another hook.
- **Do not fetch data in `useEffect`.** Fetch in a Server Component, or through the repo's TanStack Query setup for client-side reads that genuinely need it.
