/**
 * Sensitive-field redaction.
 *
 * Runs in the SDK (so secrets never leave the process) and again on ingest
 * (so a misconfigured or third-party producer cannot store them either).
 * Redaction is by key name and by value shape; it errs on the side of
 * removing too much.
 */

export const REDACTED = "[REDACTED]";

/**
 * Key names whose values are always dropped. Matched case-insensitively
 * anywhere in the key, so `x-api-key`, `refreshToken` and `userPassword`
 * are all caught. `sessionId` is deliberately NOT matched: it is a
 * correlation id, not a credential.
 */
export const DEFAULT_SENSITIVE_KEY =
  /passw|passphrase|^pass$|secret|token|authori[sz]ation|cookie|api[-_]?key|private[-_]?key|credential|card[-_]?(number|no)|credit[-_]?card|cvv|cvc|iban|^otp|[-_]otp|otp$|pin[-_]?code|signature/i;

/** Values that look like credentials no matter what key holds them. */
const SENSITIVE_VALUE_PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED], // JWT
  [/\bslk_[A-Za-z0-9]{16,}\b/g, REDACTED], // Super-Logs ingest keys
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g, REDACTED], // common API key shapes
  [/([?&](?:token|key|password|secret|auth|code|signature)=)[^&#\s]+/gi, `$1${REDACTED}`],
];

export interface RedactOptions {
  /** Extra key pattern, in addition to the defaults. */
  keys?: RegExp;
  /** Max nesting depth kept; deeper values are replaced by a marker. */
  maxDepth?: number;
}

/** Luhn check, so a 13-digit millisecond timestamp is not mistaken for a card. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const CARD_LIKE = /\b\d(?:[ -]?\d){12,18}\b/g;

export function redactString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(CARD_LIKE, (match) => (luhn(match.replace(/\D/g, "")) ? REDACTED : match));
}

function isSensitiveKey(key: string, extra?: RegExp): boolean {
  return DEFAULT_SENSITIVE_KEY.test(key) || (extra ? extra.test(key) : false);
}

/**
 * Returns a redacted, JSON-safe deep copy. Handles cycles, Errors, Dates,
 * Maps/Sets and BigInts, and never throws.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 8;
  const seen = new WeakSet<object>();

  const walk = (input: unknown, depth: number): unknown => {
    if (input === null || input === undefined) return input;
    switch (typeof input) {
      case "string":
        return redactString(input);
      case "number":
        return Number.isFinite(input) ? input : String(input);
      case "boolean":
        return input;
      case "bigint":
        return input.toString();
      case "function":
      case "symbol":
        return undefined;
    }
    const obj = input as object;
    if (seen.has(obj)) return "[Circular]";
    if (depth >= maxDepth) return "[MaxDepth]";
    seen.add(obj);
    try {
      if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
      if (obj instanceof Error) {
        return {
          name: obj.name,
          message: redactString(obj.message),
          stack: obj.stack ? redactString(obj.stack) : undefined,
        };
      }
      if (Array.isArray(obj)) return obj.slice(0, 100).map((item) => walk(item, depth + 1));
      if (obj instanceof Map) return walk(Object.fromEntries(obj), depth);
      if (obj instanceof Set) return walk([...obj], depth);
      const out: Record<string, unknown> = {};
      let count = 0;
      for (const [key, child] of Object.entries(obj)) {
        if (++count > 100) {
          out["…"] = "[Truncated]";
          break;
        }
        out[key] = isSensitiveKey(key, options.keys) ? REDACTED : walk(child, depth + 1);
      }
      return out;
    } catch {
      return "[Unserializable]";
    } finally {
      seen.delete(obj);
    }
  };

  return walk(value, 0);
}

/** Redacts every free-form part of an event in place-safe fashion (returns a copy). */
export function redactEvent<T extends { message: string; metadata?: Record<string, unknown>; error?: { message?: string; stack?: string }; tags?: Record<string, string> }>(
  event: T,
  options: RedactOptions = {},
): T {
  const copy = { ...event, message: redactString(event.message) };
  if (event.metadata) copy.metadata = redact(event.metadata, options) as Record<string, unknown>;
  if (event.tags) copy.tags = redact(event.tags, options) as Record<string, string>;
  if (event.error) {
    copy.error = {
      ...event.error,
      message: event.error.message === undefined ? undefined : redactString(event.error.message),
      stack: event.error.stack === undefined ? undefined : redactString(event.error.stack),
    };
  }
  return copy;
}
