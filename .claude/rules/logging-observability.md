# Rule: Logging and Observability

Every significant operation must emit a structured log entry. Never use bare `console.log()` in module code.

Use the logger from `@aggregator-dpg/observability`. It wraps **pino** and emits structured JSON.

Required fields per log entry:

| Field        | Description                                             |
| ------------ | ------------------------------------------------------- |
| `operation`  | Name of the function or step                            |
| `status`     | `success`, `failure`, or `skipped`                      |
| `error`      | Error message and type (failure only)                   |
| `latency_ms` | Elapsed ms (external calls)                             |
| `timestamp`  | Epoch timestamp in millis (added automatically by pino) |

Log level is read from the `LOG_LEVEL` environment variable at startup (`debug` / `info` / `warn` / `error`). Default: `info`.

```typescript
import { logger } from '@aggregator-dpg/observability';

const start = Date.now();
// ... operation ...
logger.info({
  operation: 'signalStackClient.fetchMembers',
  status: 'success',
  latency_ms: Date.now() - start,
  aggregator_id: aggregatorId,
});

// On failure:
logger.error({
  operation: 'signalStackClient.fetchMembers',
  status: 'failure',
  error: err.message,
  error_type: err.constructor.name,
  latency_ms: Date.now() - start,
});
```

Differentiate levels:

- `logger.debug` — verbose internals, only visible at `LOG_LEVEL=debug`
- `logger.info` — normal operation milestones
- `logger.warn` — recoverable anomalies
- `logger.error` — failures requiring attention

Never log PII, phone numbers, or message content outside the designated audit log path managed by the Observability package.

Propagate the inbound `x-request-id` to downstream calls (e.g. `signalstack-writer`'s `requestId`) so a single trace correlates across services.
