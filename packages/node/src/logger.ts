import { hostname } from "node:os";
import { format } from "node:util";
import {
  LEVEL_RANK,
  LIMITS,
  isLevel,
  redactEvent,
  truncate,
  type Level,
  type SuperLogsEvent,
} from "@super-logs/shared";
import { currentContext, setContext, withContext, type LogContext } from "./context.js";
import { isError, markReported, safeString, serializeError } from "./errors.js";
import { Transport, type TransportStats } from "./transport.js";
import { readSpool, writeSpool } from "./spool.js";

export interface SuperLogsOptions {
  /** Base URL of your Super-Logs server, e.g. `https://logs.example.com`. Without it the SDK is a no-op. */
  url?: string;
  /** A project ingest key (`slk_…`). Server-side only — never ship it to a browser. */
  apiKey?: string;
  service: string;
  /** Defaults to `NODE_ENV`, then `production`. */
  environment?: string;
  /** App version or git commit. */
  release?: string;
  /** Defaults to the machine hostname. */
  host?: string;
  /** Events below this level are discarded. Default `info`. */
  minLevel?: Level;
  /** Set false to disable delivery entirely (e.g. in tests). */
  enabled?: boolean;
  /** Labels added to every event. */
  tags?: Record<string, string>;
  /** Extra metadata key pattern to redact, on top of the built-in list. */
  redactKeys?: RegExp;
  /** Last chance to edit or drop (return null) an event. */
  beforeSend?: (event: SuperLogsEvent) => SuperLogsEvent | null;
  /** Also send `console.error` / `console.warn` calls. Output still reaches the console. */
  captureConsole?: ("error" | "warn")[];
  /**
   * Record uncaught exceptions (and unhandled rejections that crash the
   * process) to a spool file and send them on the next start. The process
   * still crashes exactly as it would without the SDK.
   */
  captureCrashes?: boolean;
  /** Where crash events wait for the next start. Default: `os.tmpdir()`. */
  spoolDir?: string;
  /** Responses slower than this are logged as warnings by `runWithRequest`. Default 3000. 0 disables. */
  slowRequestMs?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueSize?: number;
  timeoutMs?: number;
  /** Delivery failures. Default: one line on stderr per distinct failure. */
  onTransportError?: (error: Error) => void;
  /** For tests. */
  fetch?: typeof fetch;
}

/** Second argument of every log call: known event fields are lifted, the rest becomes metadata. */
export type LogFields = Partial<Omit<SuperLogsEvent, "level" | "message" | "error">> & {
  error?: unknown;
  [key: string]: unknown;
};

const LIFTED = new Set<keyof SuperLogsEvent>([
  "timestamp",
  "event",
  "service",
  "environment",
  "release",
  "host",
  "requestId",
  "sessionId",
  "userId",
  "route",
  "method",
  "httpStatus",
  "durationMs",
  "client",
]);

/** The console as it was before any capture, used for the SDK's own output. */
const KEY = Symbol.for("super-logs.node.console");
const g = globalThis as { [KEY]?: { error: typeof console.error; warn: typeof console.warn } };
const rawConsole = (g[KEY] ??= { error: console.error.bind(console), warn: console.warn.bind(console) });

export class SuperLogs {
  readonly service: string;
  readonly environment: string;
  readonly enabled: boolean;
  private readonly transport: Transport | undefined;
  private readonly base: Pick<SuperLogsEvent, "service" | "environment" | "release" | "host">;
  private readonly minRank: number;
  private readonly spoolFile: string | undefined;
  private readonly cleanups: (() => void)[] = [];

  /** Use `createSuperLogs()`; the constructor is shared with child loggers. */
  constructor(
    private readonly options: SuperLogsOptions,
    private readonly bound: LogFields,
    shared: { transport: Transport | undefined; spoolFile?: string },
  ) {
    this.service = options.service;
    this.environment = options.environment ?? process.env.NODE_ENV ?? "production";
    this.base = {
      service: options.service,
      environment: this.environment,
      release: options.release,
      host: options.host ?? safeHostname(),
    };
    this.minRank = LEVEL_RANK[options.minLevel ?? "info"];
    this.enabled = Boolean(shared.transport);
    this.spoolFile = shared.spoolFile;
    this.transport = shared.transport;
  }

  /** @internal */
  static create(options: SuperLogsOptions, spoolFile?: string): SuperLogs {
    const enabled = options.enabled !== false && Boolean(options.url && options.apiKey);
    const transport = enabled
      ? new Transport({
          endpoint: new URL("/api/ingest", options.url).toString(),
          apiKey: options.apiKey!,
          batchSize: options.batchSize ?? 50,
          flushIntervalMs: options.flushIntervalMs ?? 2000,
          maxQueueSize: options.maxQueueSize ?? 2000,
          timeoutMs: options.timeoutMs ?? 5000,
          fetch: options.fetch ?? fetch,
          onError: options.onTransportError ?? ((error) => rawConsole.warn(`[super-logs] ${error.message}`)),
        })
      : undefined;
    return new SuperLogs(options, {}, { transport, spoolFile });
  }

  debug(message: string | Error, fields?: LogFields): void {
    this.log("debug", message, fields);
  }
  info(message: string | Error, fields?: LogFields): void {
    this.log("info", message, fields);
  }
  warning(message: string | Error, fields?: LogFields): void {
    this.log("warning", message, fields);
  }
  /** Alias of `warning`. */
  warn(message: string | Error, fields?: LogFields): void {
    this.log("warning", message, fields);
  }
  error(message: string | Error, fields?: LogFields): void {
    this.log("error", message, fields);
  }
  critical(message: string | Error, fields?: LogFields): void {
    this.log("critical", message, fields);
  }

  /** Reports an error once, however many layers catch and re-report it. */
  captureException(error: unknown, fields?: LogFields, level: Level = "error"): void {
    if (!markReported(error)) return;
    const message = isError(error) ? `${error.name}: ${error.message}` : safeString(error);
    this.log(level, message, { ...fields, error });
  }

  log(level: Level, message: string | Error, fields: LogFields = {}): void {
    try {
      if (!isLevel(level) || LEVEL_RANK[level] < this.minRank || !this.transport) return;
      if (message instanceof Error) {
        markReported(message);
        fields = { ...fields, error: fields.error ?? message };
        message = `${message.name}: ${message.message}`;
      }
      const event = this.build(level, String(message), fields);
      const final = this.options.beforeSend ? this.options.beforeSend(event) : event;
      if (final) this.transport.push(final);
    } catch (error) {
      // Logging must never throw into the caller.
      rawConsole.warn("[super-logs] could not record an event:", error);
    }
  }

  /**
   * Forwards an already-shaped event (e.g. from a browser relay). Redaction
   * still applies; the SDK's service/environment fill only missing fields.
   */
  forward(event: SuperLogsEvent): void {
    try {
      if (!this.transport || !isLevel(event.level) || LEVEL_RANK[event.level] < this.minRank) return;
      const shaped = redactEvent({ ...this.base, ...event }, { keys: this.options.redactKeys });
      const final = this.options.beforeSend ? this.options.beforeSend(shaped) : shaped;
      if (final) this.transport.push(final);
    } catch (error) {
      rawConsole.warn("[super-logs] could not forward an event:", error);
    }
  }

  /** A logger that adds `fields` to every event and shares this one's queue. */
  child(fields: LogFields): SuperLogs {
    const tags = { ...(this.bound.tags as Record<string, string> | undefined), ...(fields.tags as Record<string, string> | undefined) };
    return new SuperLogs(this.options, { ...this.bound, ...fields, tags }, { transport: this.transport, spoolFile: this.spoolFile });
  }

  withContext<T>(ctx: LogContext, fn: () => T): T {
    return withContext(ctx, fn);
  }
  setContext(fields: LogContext): void {
    setContext(fields);
  }
  context(): LogContext | undefined {
    return currentContext();
  }

  flush(): Promise<void> {
    return this.transport?.flush() ?? Promise.resolve();
  }

  /** Flushes and stops. Call on SIGTERM. */
  async shutdown(timeoutMs?: number): Promise<void> {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    await this.transport?.close(timeoutMs);
  }

  stats(): TransportStats | undefined {
    return this.transport?.stats();
  }

  /** @internal */
  installCaptures(): void {
    if (!this.transport) return;
    if (this.options.captureConsole?.length) this.captureConsole(this.options.captureConsole);
    if (this.options.captureCrashes !== false && this.spoolFile) this.captureCrashes(this.spoolFile);
  }

  private build(level: Level, message: string, fields: LogFields): SuperLogsEvent {
    const ctx = currentContext();
    const merged: LogFields = { ...this.bound, ...fields };
    const event: SuperLogsEvent = {
      ...this.base,
      timestamp: new Date().toISOString(),
      level,
      message: truncate(message, LIMITS.maxMessageLength),
      requestId: ctx?.requestId,
      sessionId: ctx?.sessionId,
      userId: ctx?.userId,
      route: ctx?.route,
      method: ctx?.method,
    };
    const tags = { ...this.options.tags, ...ctx?.tags, ...(merged.tags as Record<string, string> | undefined) };
    if (Object.keys(tags).length) event.tags = tags;

    const metadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(merged)) {
      if (value === undefined || key === "tags" || key === "metadata") continue;
      if (key === "error") event.error = serializeError(value);
      else if (LIFTED.has(key as keyof SuperLogsEvent)) (event as unknown as Record<string, unknown>)[key] = value;
      else metadata[key] = value;
    }
    if (merged.metadata && typeof merged.metadata === "object") Object.assign(metadata, merged.metadata);
    if (Object.keys(metadata).length) event.metadata = metadata;

    for (const key of Object.keys(event) as (keyof SuperLogsEvent)[]) {
      if (event[key] === undefined) delete event[key];
    }
    return redactEvent(event, { keys: this.options.redactKeys });
  }

  private captureConsole(methods: ("error" | "warn")[]): void {
    let busy = false;
    for (const method of methods) {
      const original = console[method];
      const level: Level = method === "error" ? "error" : "warning";
      const record = (args: unknown[], error: Error | undefined) => {
        if (busy) return;
        busy = true;
        try {
          if (error && !markReported(error)) return;
          // The stack travels in `error`; the message keeps only `Name: message`.
          const text = format(...args.map((a) => (isError(a) ? `${a.name}: ${a.message}` : a)));
          this.log(level, truncate(text, LIMITS.maxMessageLength), {
            event: `console.${method}`,
            ...(error ? { error } : {}),
          });
        } finally {
          busy = false;
        }
      };
      const patched = (...args: unknown[]) => {
        original.apply(console, args);
        const error = args.find(isError);
        // Frameworks often log an error and then hand the same object to an
        // error hook with richer context (route pattern, render phase). Waiting
        // one turn lets that explicit `captureException` report it first; the
        // request context survives the wait.
        if (error) setImmediate(() => record(args, error)).unref?.();
        else record(args, undefined);
      };
      console[method] = patched;
      this.cleanups.push(() => {
        if (console[method] === patched) console[method] = original;
      });
    }
  }

  private captureCrashes(file: string): void {
    // Anything a previous crash left behind goes out first.
    for (const event of readSpool(file)) this.transport?.push(event);

    // `uncaughtExceptionMonitor` observes without changing Node's behaviour:
    // the process still crashes. There is no time to send over the network,
    // so the event is written synchronously and delivered on the next start.
    const onCrash = (error: Error, origin: string) => {
      try {
        const event = this.build("critical", `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`, {
          event: origin === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception",
          error,
        });
        writeSpool(file, event);
      } catch {
        /* nothing else we can do while crashing */
      }
    };
    process.on("uncaughtExceptionMonitor", onCrash);
    this.cleanups.push(() => process.off("uncaughtExceptionMonitor", onCrash));
  }
}

function safeHostname(): string | undefined {
  try {
    return hostname();
  } catch {
    return undefined;
  }
}
