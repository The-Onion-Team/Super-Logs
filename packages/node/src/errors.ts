import { LIMITS, redactString, truncate, type EventError } from "@super-logs/shared";

/**
 * Errors already reported, shared across SDK copies, so the same Error thrown
 * through several layers (a framework hook AND a console.error) is sent once.
 */
const KEY = Symbol.for("super-logs.node.seen-errors");
const g = globalThis as { [KEY]?: WeakSet<object> };
const seen = (g[KEY] ??= new WeakSet<object>());

/** Marks an error as reported; returns false if it already was. */
export function markReported(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return true;
  if (seen.has(error)) return false;
  seen.add(error);
  return true;
}

export function isError(value: unknown): value is Error {
  return value instanceof Error || (typeof value === "object" && value !== null && "stack" in value && "message" in value);
}

/** Error → wire shape, folding the `cause` chain into the stack. */
export function serializeError(value: unknown): EventError {
  if (!isError(value)) {
    return { name: "NonError", message: truncate(redactString(safeString(value)), LIMITS.maxMessageLength) };
  }
  let stack = value.stack ?? "";
  let cause: unknown = (value as { cause?: unknown }).cause;
  for (let depth = 0; cause !== undefined && depth < 5; depth++) {
    stack += `\nCaused by: ${isError(cause) ? (cause.stack ?? `${cause.name}: ${cause.message}`) : safeString(cause)}`;
    cause = isError(cause) ? (cause as { cause?: unknown }).cause : undefined;
  }
  const digest = (value as { digest?: unknown }).digest;
  return {
    name: value.name || "Error",
    message: truncate(redactString(String(value.message ?? "")), LIMITS.maxMessageLength),
    stack: stack ? truncate(redactString(stack), LIMITS.maxStackLength) : undefined,
    ...(typeof digest === "string" ? { componentStack: `digest: ${digest}` } : {}),
  };
}

export function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
