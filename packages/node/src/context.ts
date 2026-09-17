import { AsyncLocalStorage } from "node:async_hooks";

/** What the SDK knows about the current unit of work (a request, a job run). */
export interface LogContext {
  requestId?: string;
  sessionId?: string;
  userId?: string;
  route?: string;
  method?: string;
  tags?: Record<string, string>;
}

/**
 * The store lives on `globalThis`, not in module scope: an app can load this
 * SDK twice (a custom server run by tsx and the same code bundled by Next, for
 * instance), and both copies must see the same request context.
 */
const KEY = Symbol.for("super-logs.node.context");
const g = globalThis as { [KEY]?: AsyncLocalStorage<LogContext> };
const store = (g[KEY] ??= new AsyncLocalStorage<LogContext>());

export function currentContext(): LogContext | undefined {
  return store.getStore();
}

/** Runs `fn` with `ctx` layered over the surrounding context. */
export function withContext<T>(ctx: LogContext, fn: () => T): T {
  const parent = store.getStore();
  const merged: LogContext = { ...parent, ...ctx };
  if (parent?.tags || ctx.tags) merged.tags = { ...parent?.tags, ...ctx.tags };
  return store.run(merged, fn);
}

/**
 * Adds fields to the current context in place, e.g. the user id once the
 * session has been resolved. A no-op outside a context.
 */
export function setContext(fields: LogContext): void {
  const ctx = store.getStore();
  if (!ctx) return;
  const { tags, ...rest } = fields;
  Object.assign(ctx, rest);
  if (tags) ctx.tags = { ...ctx.tags, ...tags };
}
