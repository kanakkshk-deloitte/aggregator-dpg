---
paths:
  - '**/*.test.ts'
  - '**/*.test.tsx'
  - '**/*.integration.test.ts'
  - '**/__tests__/**'
---

# Rule: Testing Requirements

Every module must cover three test categories:

| Category          | What to test                                            |
| ----------------- | ------------------------------------------------------- |
| Normal execution  | Correct output for valid, well-formed inputs            |
| Edge cases        | Empty inputs, boundary values, missing optional fields  |
| Failure scenarios | External call failure, invalid config, upstream timeout |

- Tests live in `src/__tests__/` inside the package directory.
- Use **Vitest** as the test runner (`vitest`, `@vitest/coverage-v8`).
- Mock all external dependencies — no real API calls in unit tests. Use `vi.mock()` for module mocks and the `./testing` fake subpath from each package for in-memory fakes.
- Test file names must match: `signalStackClient.test.ts` tests `signalStackClient.ts`.
- Maintain **≥ 70% line coverage** across all packages.

```typescript
// Wrong — real HTTP call in a unit test
it('fetches members', async () => {
  const client = new SignalStackClient({ baseUrl: 'https://real.api' });
  const result = await client.fetchMembers('org-1');
});

// Correct — use the in-memory fake
import { SignalStackClientFake } from '@aggregator-dpg/signal-stack/testing';

it('fetches members', async () => {
  const client = new SignalStackClientFake();
  client.seedMembers('org-1', [{ userId: 'u-1', name: 'Test User' }]);
  const result = await client.fetchMembers('org-1');
  expect(result).toHaveLength(1);
});
```

Run tests:

```bash
pnpm --filter <package> test          # single package
pnpm -w test                          # all packages
pnpm --filter <package> test --coverage  # with coverage report
```
