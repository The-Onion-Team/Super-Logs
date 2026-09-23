/**
 * The small slice of schema validation Super-Logs actually needs, written out.
 *
 * zod cost 18.5 MB of resident memory and 61 ms of startup — roughly a quarter
 * of the server's footprint — to declare about forty fields. This costs
 * neither, and the rules below are the whole vocabulary: strings with a
 * length and maybe a pattern, bounded numbers, enums, records and one level
 * of nesting.
 *
 * A validator is a function, so it composes by wrapping; `safeParse` is sugar
 * for calling it at the root. Objects collect every field's complaint so a bad
 * `.env` reports all of its problems at once; everything else stops at the
 * first, which is all the ingest path ever reports per event.
 */

export interface Issue {
  /** Dot-joined location, e.g. `error.stack`. Empty at the root. */
  path: string;
  message: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export interface Validator<T> {
  (value: unknown, path: string): Parsed<T>;
  safeParse(value: unknown): Parsed<T>;
}

function define<T>(check: (value: unknown, path: string) => Parsed<T>): Validator<T> {
  const validator = check as Validator<T>;
  validator.safeParse = (value) => check(value, "");
  return validator;
}

const pass = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (path: string, message: string): Parsed<never> => ({ ok: false, issues: [{ path, message }] });
const child = (path: string, key: string): string => (path ? `${path}.${key}` : key);

// --- primitives ------------------------------------------------------------

export interface StringRules {
  trim?: boolean;
  min?: number;
  max?: number;
  pattern?: RegExp;
  /** Shown instead of the raw pattern, which is never useful to a caller. */
  patternMessage?: string;
}

export function string(rules: StringRules = {}): Validator<string> {
  return define((value, path) => {
    if (typeof value !== "string") return fail(path, "must be a string");
    const text = rules.trim ? value.trim() : value;
    if (rules.min !== undefined && text.length < rules.min) {
      return fail(path, rules.min === 1 ? "must not be empty" : `must be at least ${rules.min} characters`);
    }
    if (rules.max !== undefined && text.length > rules.max) return fail(path, `must be at most ${rules.max} characters`);
    if (rules.pattern && !rules.pattern.test(text)) return fail(path, rules.patternMessage ?? `must match ${rules.pattern}`);
    return pass(text);
  });
}

export interface NumberRules {
  int?: boolean;
  min?: number;
  max?: number;
  /** Accept a numeric string, for query parameters and the environment. */
  coerce?: boolean;
}

export function number(rules: NumberRules = {}): Validator<number> {
  return define((value, path) => {
    let parsed: number;
    if (typeof value === "number") parsed = value;
    else if (rules.coerce && typeof value === "string" && value.trim() !== "") parsed = Number(value);
    else return fail(path, "must be a number");
    if (!Number.isFinite(parsed)) return fail(path, "must be a number");
    if (rules.int && !Number.isInteger(parsed)) return fail(path, "must be a whole number");
    if (rules.min !== undefined && parsed < rules.min) return fail(path, `must be ${rules.min} or more`);
    if (rules.max !== undefined && parsed > rules.max) return fail(path, `must be ${rules.max} or less`);
    return pass(parsed);
  });
}

export function boolean(): Validator<boolean> {
  return define((value, path) => {
    if (typeof value === "boolean") return pass(value);
    // Checkboxes and query strings arrive as text.
    if (value === "true") return pass(true);
    if (value === "false") return pass(false);
    return fail(path, "must be true or false");
  });
}

export function enumOf<const T extends readonly string[]>(values: T): Validator<T[number]> {
  return define((value, path) =>
    typeof value === "string" && (values as readonly string[]).includes(value)
      ? pass(value as T[number])
      : fail(path, `must be one of: ${values.join(", ")}`),
  );
}

/** Anything at all, including `undefined`. Used where the shape is the caller's. */
export const unknown: Validator<unknown> = define((value) => pass(value));

/** An absolute http(s) URL. Stricter than "parses as a URL": `mailto:` is not a dashboard. */
export function url(): Validator<string> {
  return define((value, path) => {
    if (typeof value !== "string") return fail(path, "must be a string");
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return fail(path, "must be a URL, including https://");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fail(path, "must be an http:// or https:// URL");
    return pass(value);
  });
}

export function email(): Validator<string> {
  return define((value, path) =>
    typeof value === "string" && value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
      ? pass(value)
      : fail(path, "must be an email address"),
  );
}

// --- combinators -----------------------------------------------------------

/** Absent is allowed. `null` is not, which matches how JSON callers spell "missing". */
export function optional<T>(inner: Validator<T>): Validator<T | undefined> {
  return define((value, path) => (value === undefined ? pass(undefined) : inner(value, path)));
}

export function withDefault<T>(inner: Validator<T>, fallback: T): Validator<T> {
  return define((value, path) => (value === undefined ? pass(fallback) : inner(value, path)));
}

/** Reshapes a value once it is known to be valid. */
export function map<A, B>(inner: Validator<A>, transform: (value: A) => B): Validator<B> {
  return define((value, path) => {
    const result = inner(value, path);
    return result.ok ? pass(transform(result.value)) : result;
  });
}

/** A rule that needs more than one field, reported against `path`. */
export function refine<T>(inner: Validator<T>, holds: (value: T) => boolean, issue: Issue): Validator<T> {
  return define((value, path) => {
    const result = inner(value, path);
    if (!result.ok || holds(result.value)) return result;
    return { ok: false, issues: [{ path: child(path, issue.path), message: issue.message }] };
  });
}

export function array<T>(item: Validator<T>, rules: { min?: number; max?: number } = {}): Validator<T[]> {
  return define((value, path) => {
    if (!Array.isArray(value)) return fail(path, "must be an array");
    if (rules.min !== undefined && value.length < rules.min) return fail(path, `must have at least ${rules.min} items`);
    if (rules.max !== undefined && value.length > rules.max) return fail(path, `must have at most ${rules.max} items`);
    const out: T[] = [];
    for (const [index, entry] of value.entries()) {
      const result = item(entry, child(path, String(index)));
      if (!result.ok) return result;
      out.push(result.value);
    }
    return pass(out);
  });
}

export function record<T>(
  key: Validator<string>,
  value: Validator<T>,
  rules: { maxEntries?: number; maxEntriesMessage?: string } = {},
): Validator<Record<string, T>> {
  return define((input, path) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return fail(path, "must be an object");
    const source = input as Record<string, unknown>;
    const keys = Object.keys(source);
    if (rules.maxEntries !== undefined && keys.length > rules.maxEntries) {
      return fail(path, rules.maxEntriesMessage ?? `must have at most ${rules.maxEntries} entries`);
    }
    const out: Record<string, T> = {};
    for (const name of keys) {
      const at = child(path, name);
      const checkedKey = key(name, at);
      if (!checkedKey.ok) return checkedKey;
      const checkedValue = value(source[name], at);
      if (!checkedValue.ok) return checkedValue;
      out[checkedKey.value] = checkedValue.value;
    }
    return pass(out);
  });
}

// --- objects ---------------------------------------------------------------

type Shape = Record<string, Validator<unknown>>;

/** The value a validator produces, for deriving types from a schema. */
export type Infer<V> = V extends Validator<infer T> ? T : never;

type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends Infer<S[K]> ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;

/** Optional fields stay optional on the way out, as they would with zod. */
export type Output<S extends Shape> = { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> };

export function object<S extends Shape>(shape: S): Validator<Output<S>> {
  const fields = Object.entries(shape);
  return define((value, path) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(path, "must be an object");
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const issues: Issue[] = [];
    for (const [name, check] of fields) {
      const result = check(source[name], child(path, name));
      if (!result.ok) issues.push(...result.issues);
      else if (result.value !== undefined) out[name] = result.value;
    }
    return issues.length > 0 ? { ok: false, issues } : pass(out as Output<S>);
  });
}
