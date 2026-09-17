import {
  LEVEL_RANK,
  LIMITS,
  REQUEST_ID_HEADER,
  isLevel,
  randomId,
  redactEvent,
  truncate,
  type EventError,
  type Level,
  type SuperLogsEvent,
} from "@super-logs/shared";
import { clientInfo } from "./client-info.js";

export { parseUserAgent } from "./client-info.js";
export { LEVELS, REQUEST_ID_HEADER, type Level, type SuperLogsEvent } from "@super-logs/shared";

export interface FetchCaptureOptions {
  /** Responses slower than this are reported as warnings. Default 5000. 0 disables. */
  slowMs?: number;
  /** URLs never tracked (matched against the full URL). */
  ignore?: RegExp;
  /** Report 4xx responses too (as warnings). Default false. */
  clientErrors?: boolean;
}

export interface BrowserSuperLogsOptions {
  /**
   * Where batches are POSTed. Point it at a same-origin relay on your server
   * (e.g. `/api/telemetry`) — never put an ingest key in the browser.
   */
  endpoint: string;
  service?: string;
  environment?: string;
  release?: string;
  enabled?: boolean;
  /** Default `info`. */
  minLevel?: Level;
  /** Fraction of sessions whose debug/info events are sent (errors always are). Default 1. */
  sampleRate?: number;
  /** `window.onerror` and unhandled promise rejections. Default true. */
  captureErrors?: boolean;
  /** Failed and slow `fetch` calls. Default true. */
  captureFetch?: boolean | FetchCaptureOptions;
  /** Add an `x-request-id` header to same-origin requests, so server logs correlate. Default true. */
  propagateRequestId?: boolean;
  /** Also send `console.error`. Default false. */
  captureConsole?: boolean;
  /** Error messages never reported. */
  ignoreErrors?: RegExp[];
  /** Hard cap on events sent per minute from one page. Default 30. */
  maxEventsPerMinute?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  tags?: Record<string, string>;
  redactKeys?: RegExp;
  beforeSend?: (event: SuperLogsEvent) => SuperLogsEvent | null;
}

export type LogFields = Partial<Omit<SuperLogsEvent, "level" | "message" | "error">> & {
  error?: unknown;
  [key: string]: unknown;
};

/** A local trail of what happened on the page, kept for diagnostic reports. Never sent on its own. */
export interface Breadcrumb {
  at: string;
  type: "navigation" | "request" | "event";
  level: Level;
  message: string;
  requestId?: string;
}

export interface BrowserSuperLogs {
  debug(message: string | Error, fields?: LogFields): void;
  info(message: string | Error, fields?: LogFields): void;
  warning(message: string | Error, fields?: LogFields): void;
  warn(message: string | Error, fields?: LogFields): void;
  error(message: string | Error, fields?: LogFields): void;
  critical(message: string | Error, fields?: LogFields): void;
  captureException(error: unknown, fields?: LogFields): void;
  log(level: Level, message: string | Error, fields?: LogFields): void;
  setTags(tags: Record<string, string>): void;
  readonly sessionId: string;
  /** The recent page trail (navigations, requests, events), newest last. */
  breadcrumbs(): Breadcrumb[];
  flush(): Promise<void>;
  /** Removes every hook the SDK installed. */
  shutdown(): void;
}

const DEFAULT_IGNORE = [/^ResizeObserver loop/, /^Script error\.?$/, /Loading chunk \d+ failed/, /AbortError/];
const INSTANCE = Symbol.for("super-logs.browser.instance");
const REPORTED = new WeakSet<object>();

const noop: BrowserSuperLogs = {
  debug() {},
  info() {},
  warning() {},
  warn() {},
  error() {},
  critical() {},
  captureException() {},
  log() {},
  setTags() {},
  sessionId: "",
  breadcrumbs: () => [],
  flush: () => Promise.resolve(),
  shutdown() {},
};

/**
 * Creates (or returns the already-installed) browser logger. Safe to call
 * during server rendering: it returns a no-op there.
 *
 * ```ts
 * const logs = createSuperLogs({ endpoint: "/api/telemetry", release: "1.3.0" });
 * logs.error("Failed to load standings", { error, endpoint: "/api/standings" });
 * ```
 */
export function createSuperLogs(options: BrowserSuperLogsOptions): BrowserSuperLogs {
  if (typeof window === "undefined" || options.enabled === false) return noop;
  const w = window as unknown as { [INSTANCE]?: BrowserSuperLogs };
  return (w[INSTANCE] ??= install(options));
}

/** The installed logger, or a no-op before `createSuperLogs` ran. */
export function getSuperLogs(): BrowserSuperLogs {
  if (typeof window === "undefined") return noop;
  return (window as unknown as { [INSTANCE]?: BrowserSuperLogs })[INSTANCE] ?? noop;
}

function install(options: BrowserSuperLogsOptions): BrowserSuperLogs {
  const endpointUrl = new URL(options.endpoint, location.href).href;
  const minRank = LEVEL_RANK[options.minLevel ?? "info"];
  const sessionId = readSessionId();
  const sampled = Math.random() < (options.sampleRate ?? 1);
  const client = clientInfo();
  const ignoreErrors = [...DEFAULT_IGNORE, ...(options.ignoreErrors ?? [])];
  const perMinute = options.maxEventsPerMinute ?? 30;
  const batchSize = Math.min(options.batchSize ?? 10, LIMITS.maxEventsPerBatch);
  const maxQueue = options.maxQueueSize ?? 100;
  let tags: Record<string, string> = { ...options.tags };

  const queue: SuperLogsEvent[] = [];
  const trail: Breadcrumb[] = [];
  const cleanups: (() => void)[] = [];
  const recent = new Map<string, number>();
  let windowStart = Date.now();
  let sentThisWindow = 0;
  let backoffUntil = 0;
  let failures = 0;
  let inFlight: Promise<void> | undefined;
  const originalFetch = window.fetch;
  const rawFetch: typeof fetch = (input, init) => originalFetch.call(window, input, init);

  const crumb = (entry: Omit<Breadcrumb, "at">) => {
    trail.push({ ...entry, at: new Date().toISOString(), message: truncate(entry.message, 300) });
    if (trail.length > 50) trail.shift();
  };

  const allow = (key: string): boolean => {
    const now = Date.now();
    if (now - windowStart > 60_000) {
      windowStart = now;
      sentThisWindow = 0;
    }
    // The same message within 5 s is almost always a render loop or a retry storm.
    const last = recent.get(key);
    if (last !== undefined && now - last < 5_000) return false;
    recent.set(key, now);
    if (recent.size > 200) recent.clear();
    return ++sentThisWindow <= perMinute;
  };

  const log = (level: Level, message: string | Error, fields: LogFields = {}): void => {
    try {
      if (!isLevel(level) || LEVEL_RANK[level] < minRank) return;
      if (LEVEL_RANK[level] < LEVEL_RANK.warning && !sampled) return;
      if (message instanceof Error) {
        fields = { ...fields, error: fields.error ?? message };
        message = `${message.name}: ${message.message}`;
      }
      const text = truncate(String(message), LIMITS.maxMessageLength);
      if (ignoreErrors.some((re) => re.test(text))) return;
      if (!allow(`${level}|${text}`)) return;

      const event = build(level, text, fields);
      const final = options.beforeSend ? options.beforeSend(event) : event;
      if (!final) return;
      crumb({ type: "event", level, message: text, requestId: final.requestId });
      if (queue.length >= maxQueue) queue.shift();
      queue.push(final);
      if (LEVEL_RANK[level] >= LEVEL_RANK.error || queue.length >= batchSize) void flush();
    } catch {
      /* never break the page */
    }
  };

  const build = (level: Level, message: string, fields: LogFields): SuperLogsEvent => {
    const event: SuperLogsEvent = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: options.service,
      environment: options.environment,
      release: options.release,
      sessionId,
      route: location.pathname,
      client,
    };
    const metadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (key === "error") event.error = serializeError(value);
      else if (key === "tags" || key === "metadata") continue;
      else if (key in LIFTED) (event as unknown as Record<string, unknown>)[key] = value;
      else metadata[key] = value;
    }
    if (fields.metadata && typeof fields.metadata === "object") Object.assign(metadata, fields.metadata);
    if (Object.keys(metadata).length) event.metadata = metadata;
    const allTags = { ...tags, ...(fields.tags as Record<string, string> | undefined) };
    if (Object.keys(allTags).length) event.tags = allTags;
    for (const key of Object.keys(event) as (keyof SuperLogsEvent)[]) {
      if (event[key] === undefined) delete event[key];
    }
    return redactEvent(event, { keys: options.redactKeys });
  };

  const send = async (events: SuperLogsEvent[]): Promise<boolean> => {
    const body = JSON.stringify({ events });
    try {
      const response = await rawFetch(endpointUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        credentials: "same-origin",
        // keepalive lets the request outlive the page, but is capped at 64 KB.
        keepalive: body.length < 60_000,
      });
      // 4xx other than 429 will not get better by retrying.
      return response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429);
    } catch {
      return false;
    }
  };

  const flush = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      while (queue.length && Date.now() >= backoffUntil) {
        const batch = queue.splice(0, batchSize);
        if (await send(batch)) {
          failures = 0;
          continue;
        }
        failures++;
        backoffUntil = Date.now() + Math.min(60_000, 2_000 * 2 ** (failures - 1));
        if (failures <= 3) queue.unshift(...batch.slice(0, Math.max(0, maxQueue - queue.length)));
        break;
      }
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  /** On page hide, hand whatever is left to the browser, which sends it even as the page unloads. */
  const beacon = () => {
    if (!queue.length) return;
    const events = queue.splice(0, LIMITS.maxEventsPerBatch);
    const body = JSON.stringify({ events });
    const sent =
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(endpointUrl, new Blob([body], { type: "application/json" }));
    if (!sent) void send(events);
  };

  const timer = window.setInterval(() => void flush(), options.flushIntervalMs ?? 5_000);
  cleanups.push(() => window.clearInterval(timer));
  on(window, "pagehide", beacon, cleanups);
  on(document, "visibilitychange", () => document.visibilityState === "hidden" && beacon(), cleanups);

  // --- automatic capture ---------------------------------------------------

  if (options.captureErrors !== false) {
    on(
      window,
      "error",
      (event: Event) => {
        const e = event as ErrorEvent;
        // Resource load failures arrive here too, without a message; skip them.
        if (!e.message && !e.error) return;
        const error = e.error ?? { name: "Error", message: e.message, stack: `    at ${e.filename}:${e.lineno}:${e.colno}` };
        if (typeof error === "object" && REPORTED.has(error)) return;
        if (typeof error === "object" && error) REPORTED.add(error);
        log("error", e.error instanceof Error ? e.error : e.message || "Unknown error", {
          event: "unhandled_error",
          error,
        });
      },
      cleanups,
    );
    on(
      window,
      "unhandledrejection",
      (event: Event) => {
        const reason = (event as PromiseRejectionEvent).reason;
        if (typeof reason === "object" && reason && REPORTED.has(reason)) return;
        if (typeof reason === "object" && reason) REPORTED.add(reason);
        log("error", reason instanceof Error ? reason : `Unhandled rejection: ${stringify(reason)}`, {
          event: "unhandled_rejection",
          error: reason,
        });
      },
      cleanups,
    );
  }

  const fetchOptions: FetchCaptureOptions | undefined =
    options.captureFetch === false ? undefined : options.captureFetch === true || !options.captureFetch ? {} : options.captureFetch;
  const propagate = options.propagateRequestId !== false;
  if (fetchOptions || propagate) {
    const slowMs = fetchOptions?.slowMs ?? 5_000;
    const wrapped: typeof fetch = async (input, init) => {
      let url: URL;
      try {
        url = new URL(input instanceof Request ? input.url : String(input), location.href);
      } catch {
        return rawFetch(input, init);
      }
      if (url.href === endpointUrl || fetchOptions?.ignore?.test(url.href)) return rawFetch(input, init);

      const sameOrigin = url.origin === location.origin;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      let requestId: string | undefined;
      let nextInit = init;
      // Only same-origin: a custom header on a cross-origin call would force a CORS preflight.
      if (propagate && sameOrigin) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        requestId = headers.get(REQUEST_ID_HEADER) ?? randomId("req_");
        headers.set(REQUEST_ID_HEADER, requestId);
        nextInit = { ...init, headers };
      }
      const endpoint = sameOrigin ? url.pathname : `${url.origin}${url.pathname}`;
      const fields = {
        event: "http_request",
        requestId,
        method,
        endpoint,
        // Next.js Server Actions are POSTs carrying this header.
        ...(new Headers(nextInit?.headers).has("next-action") ? { serverAction: true } : {}),
      };
      const started = performance.now();
      try {
        const response = await rawFetch(input, nextInit);
        const durationMs = Math.round(performance.now() - started);
        crumb({ type: "request", level: response.ok ? "info" : "warning", message: `${method} ${endpoint} → ${response.status} (${durationMs}ms)`, requestId });
        if (fetchOptions) {
          const withStatus = { ...fields, httpStatus: response.status, durationMs };
          if (response.status >= 500) log("error", `${method} ${endpoint} failed with HTTP ${response.status}`, { ...withStatus, event: "api_request_failed" });
          else if (response.status >= 400 && fetchOptions.clientErrors) log("warning", `${method} ${endpoint} answered HTTP ${response.status}`, { ...withStatus, event: "api_request_rejected" });
          else if (slowMs > 0 && durationMs >= slowMs) log("warning", `Slow request: ${method} ${endpoint} took ${durationMs}ms`, { ...withStatus, event: "api_request_slow" });
        }
        return response;
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        crumb({ type: "request", level: "warning", message: `${method} ${endpoint} ${aborted ? "aborted" : "failed"}`, requestId });
        if (fetchOptions && !aborted && navigator.onLine !== false) {
          log("warning", `${method} ${endpoint} could not be reached`, {
            ...fields,
            event: "api_request_network_error",
            durationMs: Math.round(performance.now() - started),
            error,
          });
        }
        throw error;
      }
    };
    window.fetch = wrapped;
    cleanups.push(() => {
      if (window.fetch === wrapped) window.fetch = originalFetch;
    });
  }

  if (options.captureConsole) {
    const original = console.error;
    let busy = false;
    const patched = (...args: unknown[]) => {
      original.apply(console, args);
      if (busy) return;
      busy = true;
      try {
        const error = args.find((a) => a instanceof Error) as Error | undefined;
        if (error && REPORTED.has(error)) return;
        if (error) REPORTED.add(error);
        log("error", args.map(stringify).join(" "), { event: "console.error", error });
      } finally {
        busy = false;
      }
    };
    console.error = patched;
    cleanups.push(() => {
      if (console.error === patched) console.error = original;
    });
  }

  // Navigation trail for diagnostics (history API + back/forward).
  let lastPath = location.pathname;
  const onNavigate = () => {
    if (location.pathname === lastPath) return;
    crumb({ type: "navigation", level: "info", message: `${lastPath} → ${location.pathname}` });
    lastPath = location.pathname;
  };
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method];
    const patched = function (this: History, ...args: Parameters<History["pushState"]>) {
      const result = original.apply(this, args);
      onNavigate();
      return result;
    };
    history[method] = patched;
    cleanups.push(() => {
      if (history[method] === patched) history[method] = original;
    });
  }
  on(window, "popstate", onNavigate, cleanups);

  const captureException = (error: unknown, fields?: LogFields) => {
    if (typeof error === "object" && error) {
      if (REPORTED.has(error)) return;
      REPORTED.add(error);
    }
    log("error", error instanceof Error ? error : stringify(error), { ...fields, error });
  };

  return {
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warning: (m, f) => log("warning", m, f),
    warn: (m, f) => log("warning", m, f),
    error: (m, f) => log("error", m, f),
    critical: (m, f) => log("critical", m, f),
    captureException,
    log,
    setTags(next) {
      tags = { ...tags, ...next };
    },
    sessionId,
    breadcrumbs: () => trail.slice(),
    flush,
    shutdown() {
      beacon();
      for (const cleanup of cleanups.splice(0)) cleanup();
      delete (window as unknown as { [INSTANCE]?: BrowserSuperLogs })[INSTANCE];
    },
  };
}

const LIFTED: Record<string, true> = {
  event: true,
  requestId: true,
  route: true,
  method: true,
  httpStatus: true,
  durationMs: true,
  release: true,
  timestamp: true,
};

function on(target: EventTarget, type: string, handler: (event: Event) => void, cleanups: (() => void)[]) {
  target.addEventListener(type, handler);
  cleanups.push(() => target.removeEventListener(type, handler));
}

function serializeError(value: unknown): EventError {
  if (value && typeof value === "object" && "message" in value) {
    const e = value as { name?: unknown; message?: unknown; stack?: unknown; componentStack?: unknown; digest?: unknown };
    return {
      name: typeof e.name === "string" ? e.name : "Error",
      message: truncate(String(e.message), LIMITS.maxMessageLength),
      stack: typeof e.stack === "string" ? truncate(e.stack, LIMITS.maxStackLength) : undefined,
      componentStack:
        typeof e.componentStack === "string"
          ? truncate(e.componentStack, LIMITS.maxStackLength)
          : typeof e.digest === "string"
            ? `digest: ${e.digest}`
            : undefined,
    };
  }
  return { name: "NonError", message: truncate(stringify(value), LIMITS.maxMessageLength) };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function readSessionId(): string {
  const key = "super-logs.sid";
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const id = randomId("sess_");
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return randomId("sess_");
  }
}
