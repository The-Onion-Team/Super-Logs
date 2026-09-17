# @super-logs/browser

Browser SDK for [Super-Logs](../../README.md). It captures errors and failed
requests and correlates them with your server logs. It has no dependencies,
and the React integration is optional.

```ts
import { createSuperLogs } from "@super-logs/browser";

const logs = createSuperLogs({
  endpoint: "/api/telemetry", // a relay on your own server (see @super-logs/node)
  release: "1.3.0",
});

logs.error("Failed to load standings", { error, endpoint: "/api/standings" });
```

`createSuperLogs` is idempotent: calling it twice (React StrictMode, hot
reload) returns the same instance. During server rendering it returns a
no-op. `getSuperLogs()` returns the installed instance anywhere.

## What it captures

| | Default |
|---|---|
| Uncaught errors and unhandled rejections | on |
| `fetch` responses with status ≥ 500, network failures and slow calls (5 s) | on (`captureFetch`) |
| 4xx responses | off (`captureFetch: { clientErrors: true }`) |
| `x-request-id` on same-origin requests | on (`propagateRequestId`) |
| `console.error` | off (`captureConsole`) |
| Page trail (navigations, requests, events), kept locally | on, see `breadcrumbs()` |

It also has built-in noise control: known noise (`ResizeObserver loop…`,
`Script error.`) is ignored. The same message is sent at most once every 5
seconds, and at most 30 events per minute are sent from a page. `sampleRate`
thins debug/info events (errors are always sent). Events are batched, sent
with `keepalive`, and handed to `sendBeacon` when the page is hidden.

Only the path of the current page is recorded, never its query string.
Sensitive keys and credential-shaped values are redacted before sending. The
SDK never identifies the user: the server relay does that.

## React

```tsx
import { SuperLogsErrorBoundary, reportReactError } from "@super-logs/browser/react";

<SuperLogsErrorBoundary fallback={({ reset }) => <button onClick={reset}>Retry</button>}>
  <App />
</SuperLogsErrorBoundary>;

// Next.js app/error.tsx / global-error.tsx
useEffect(() => reportReactError(error), [error]);
```
