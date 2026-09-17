import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import { REQUEST_ID_HEADER, REQUEST_ID_PATTERN, randomId } from "@super-logs/shared";
import { withContext } from "./context.js";
import type { SuperLogs } from "./logger.js";

export interface RequestTrackingOptions {
  /** Paths that are never logged (still correlated). Default: static assets. */
  ignore?: RegExp;
  /** Responses slower than this are warnings. Default: the logger's `slowRequestMs` (3000). 0 disables. */
  slowRequestMs?: number;
  /** Read a trusted request id from a proxy header instead, e.g. `cf-ray`. */
  fallbackHeader?: string;
}

const DEFAULT_IGNORE = /^\/(?:_next\/static|_next\/image|favicon\.ico|robots\.txt|assets\/)/;

export function pathOf(url: string | undefined): string {
  if (!url) return "/";
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

export function requestIdFrom(req: IncomingMessage, fallbackHeader?: string): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  if (value && REQUEST_ID_PATTERN.test(value)) return value;
  const fallback = fallbackHeader ? req.headers[fallbackHeader.toLowerCase()] : undefined;
  const fb = Array.isArray(fallback) ? fallback[0] : fallback;
  if (fb && REQUEST_ID_PATTERN.test(fb)) return fb;
  return randomId("req_");
}

/**
 * Wraps one plain Node HTTP request: assigns (or accepts) a request id,
 * echoes it back as `x-request-id`, runs `fn` inside that context, and logs
 * 5xx and slow responses when the response finishes.
 */
export function runWithRequest<T>(
  logger: SuperLogs,
  req: IncomingMessage,
  res: ServerResponse,
  fn: () => T,
  options: RequestTrackingOptions = {},
): T {
  const requestId = requestIdFrom(req, options.fallbackHeader);
  const route = pathOf(req.url);
  const method = req.method ?? "GET";
  try {
    if (!res.headersSent) res.setHeader(REQUEST_ID_HEADER, requestId);
  } catch {
    /* headers already written by someone else */
  }

  const ignored = (options.ignore ?? DEFAULT_IGNORE).test(route);
  const slowMs = options.slowRequestMs ?? 3000;
  const started = performance.now();

  return withContext({ requestId, route, method }, () => {
    if (!ignored) {
      res.once("finish", () => {
        const durationMs = Math.round(performance.now() - started);
        const status = res.statusCode;
        const fields = { event: "http_request", httpStatus: status, durationMs };
        if (status >= 500) logger.error(`${method} ${route} → ${status}`, fields);
        else if (slowMs > 0 && durationMs >= slowMs && !isStreaming(req)) {
          logger.warning(`Slow response: ${method} ${route} took ${durationMs}ms`, { ...fields, event: "http_slow_request" });
        } else logger.debug(`${method} ${route} → ${status}`, fields);
      });
    }
    return fn();
  });
}

/** Long-lived connections (websockets, SSE, long polling) are slow by design. */
function isStreaming(req: IncomingMessage): boolean {
  const accept = req.headers.accept ?? "";
  return accept.includes("text/event-stream") || Boolean(req.headers.upgrade) || (req.url ?? "").includes("/socket");
}
