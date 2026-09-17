# @super-logs/node

Node.js SDK for [Super-Logs](../../README.md). It has no runtime dependencies
and supports Node ≥ 18.17.

```ts
import { createSuperLogs } from "@super-logs/node";

const logs = createSuperLogs({
  url: process.env.SUPER_LOGS_URL,
  apiKey: process.env.SUPER_LOGS_API_KEY,
  service: "api",
});

logs.info("League loaded", { leagueId });
logs.error("Database query failed", { error, queryName: "getLeague" });
logs.captureException(error);            // reported once, however many layers catch it
logs.child({ tags: { worker: "ingest" } }).warning("Source slow");
```

The second argument's known fields (`event`, `route`, `httpStatus`,
`requestId`, `userId`, `tags`, …) become event fields. `error` is serialized
together with its `cause` chain, and everything else goes to `metadata`.
Sensitive keys and credential-shaped values are redacted before they leave
the process.

## Options

| Option | Default | |
|---|---|---|
| `url`, `apiKey` | — | Both required to send; otherwise the SDK is a silent no-op. |
| `service` | — | Required. |
| `environment` | `NODE_ENV` or `production` | |
| `release`, `host`, `tags` | —, hostname, — | Added to every event. |
| `minLevel` | `info` | |
| `captureConsole` | `[]` | `["error", "warn"]` also sends console calls. Console output is unchanged. |
| `captureCrashes` | `true` | Uncaught exceptions are written to a spool file and sent on the next start. The crash itself is unchanged. |
| `spoolDir` | `os.tmpdir()` | |
| `slowRequestMs` | `3000` | For `runWithRequest`. |
| `batchSize`, `flushIntervalMs`, `maxQueueSize`, `timeoutMs` | 50, 2000, 2000, 5000 | |
| `redactKeys`, `beforeSend`, `onTransportError` | | |

## Request correlation

```ts
http.createServer((req, res) => logs.runWithRequest(req, res, () => app(req, res)));
```

`runWithRequest` adopts a valid incoming `x-request-id` (or creates one) and
echoes it back. Every log call inside the request carries it. When the
response finishes, 5xx responses are logged as errors and slow ones as
warnings. Use `logs.setContext({ userId })` once you know the user, and
`logs.withContext({ requestId }, fn)` for jobs.

The context and the logger live on `globalThis`, so an app that loads the SDK
twice (a custom server plus a framework bundle) still shares one queue and one
context. `getSuperLogs(options)` returns the process-wide instance.

## Browser relay

```ts
export const POST = createBrowserRelay(logs, {
  enrich: async (request) => ({ userId: await userIdFrom(request), tags: { league } }),
  eventsPerMinute: 120,
});
```

The relay is a standard `(Request) => Promise<Response>` handler. It accepts
only same-origin posts and keeps only known fields. It caps the level at
`error`, rate-limits each client, and forwards events with the server's
environment and key.

## Shutdown

```ts
process.on("SIGTERM", async () => {
  await logs.shutdown(); // flushes, bounded by timeoutMs
  process.exit(0);
});
```
