import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SuperLogs, type SuperLogsOptions } from "./logger.js";
import { runWithRequest, type RequestTrackingOptions } from "./http.js";

export { SuperLogs, type SuperLogsOptions, type LogFields } from "./logger.js";
export { currentContext, withContext, setContext, type LogContext } from "./context.js";
export { createBrowserRelay, type BrowserRelayOptions } from "./relay.js";
export { pathOf, requestIdFrom, type RequestTrackingOptions } from "./http.js";
export { serializeError } from "./errors.js";
export type { TransportStats } from "./transport.js";
export {
  LEVELS,
  REQUEST_ID_HEADER,
  type Level,
  type SuperLogsEvent,
  type EventError,
  type ClientInfo,
} from "@super-logs/shared";

export interface NodeSuperLogs extends SuperLogs {
  /** Correlates and logs one `node:http` request. See `runWithRequest`. */
  runWithRequest<T>(req: IncomingMessage, res: ServerResponse, fn: () => T, options?: RequestTrackingOptions): T;
}

/**
 * Creates a logger. Without `url` + `apiKey` it is a silent no-op, so the
 * same code runs in development, CI and production.
 *
 * ```ts
 * const logs = createSuperLogs({
 *   url: process.env.SUPER_LOGS_URL,
 *   apiKey: process.env.SUPER_LOGS_API_KEY,
 *   service: "api",
 *   captureConsole: ["error"],
 * });
 * logs.error("Database query failed", { error, queryName: "getLeague" });
 * ```
 */
export function createSuperLogs(options: SuperLogsOptions): NodeSuperLogs {
  const safeService = options.service.replace(/[^\w.-]/g, "_").slice(0, 60);
  const spoolFile = join(options.spoolDir ?? tmpdir(), `super-logs-${safeService}.spool.jsonl`);
  const logger = SuperLogs.create(options, spoolFile) as NodeSuperLogs;
  logger.runWithRequest = (req, res, fn, tracking) =>
    runWithRequest(logger, req, res, fn, { slowRequestMs: options.slowRequestMs, ...tracking });
  logger.installCaptures();
  return logger;
}

/**
 * A process-wide logger, created on first use. Useful when the same code is
 * loaded twice (a custom server and a framework bundle): both get one queue.
 */
const KEY = Symbol.for("super-logs.node.instance");
const g = globalThis as { [KEY]?: NodeSuperLogs };

export function getSuperLogs(options: SuperLogsOptions): NodeSuperLogs {
  return (g[KEY] ??= createSuperLogs(options));
}
