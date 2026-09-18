/**
 * Deterministic error fingerprints (IDEA §28).
 *
 * Two occurrences of "the same problem" must produce the same fingerprint even
 * when ids, numbers, timestamps or line/column offsets differ. The inputs are
 * normalised text; the hash is FNV-1a so it runs identically in Node and in
 * the browser without any crypto API.
 */

export interface FingerprintInput {
  service?: string;
  level?: string;
  event?: string;
  message: string;
  route?: string;
  error?: { name?: string; message?: string; stack?: string };
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX = /\b(?:0x)?[0-9a-f]{12,}\b/gi;
const CUID = /\bc[a-z0-9]{20,32}\b/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
const IP = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g;
const QUOTED = /(["'`])(?:(?!\1)[^\\\n]|\\.){0,200}\1/g;
const URL_QUERY = /\?[^\s"')]*/g;
// The trailing unit is part of the match: `\b` never falls between a digit and a
// letter, so without it `245ms`, `512kb` and `5s` survive normalisation and every
// timing in a message becomes its own error group. Leading `\b` still protects
// identifiers whose digits follow letters (utf8, sha256, v2beta).
const NUMBER = /\b\d+(?:\.\d+)?[a-z]{0,4}\b/gi;
const EMAIL = /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/gi;

/** Turns a concrete message into its template: `User 42 not found` → `User <n> not found`. */
export function normalizeMessage(message: string): string {
  return message
    .slice(0, 500)
    .replace(UUID, "<uuid>")
    .replace(EMAIL, "<email>")
    .replace(ISO_DATE, "<date>")
    .replace(IP, "<ip>")
    .replace(URL_QUERY, "?<query>")
    .replace(QUOTED, "<str>")
    .replace(CUID, "<id>")
    .replace(HEX, "<hex>")
    .replace(NUMBER, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** Route ids become placeholders so `/league/42/team/7` groups with `/league/9/team/3`. */
export function normalizeRoute(route: string): string {
  const path = route.split(/[?#]/)[0] ?? "";
  return path
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/.test(segment)) return ":n";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":uuid";
      if (/^[0-9a-f]{12,}$/i.test(segment) || /^c[a-z0-9]{20,32}$/.test(segment)) return ":id";
      return segment;
    })
    .join("/");
}

/**
 * The first stack frames that belong to the application, without line and
 * column numbers (they move with every unrelated edit) and without bundler
 * hashes in file names.
 */
export function stackSignature(stack: string, frames = 3): string {
  const out: string[] = [];
  for (const raw of stack.split("\n").slice(1)) {
    const line = raw.trim();
    if (!line) continue;
    if (/node_modules|node:internal|<anonymous>|\(native\)|webpack\/runtime/.test(line)) continue;
    const cleaned = line
      .replace(/^at\s+/, "")
      .replace(/:\d+(?::\d+)?\)?$/, "")
      .replace(/\?[^\s)]*/g, "")
      .replace(/[.-][0-9a-f]{8,}(?=\.\w+)/gi, "")
      .replace(/https?:\/\/[^/\s]+/g, "")
      .replace(/\s*\(/, " (");
    out.push(cleaned);
    if (out.length >= frames) break;
  }
  return out.join(" | ");
}

/** FNV-1a 32-bit, twice with different seeds for a 64-bit-ish hex digest. */
export function hash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

export function fingerprintParts(input: FingerprintInput): string[] {
  const stack = input.error?.stack ? stackSignature(input.error.stack) : "";
  return [
    input.service ?? "",
    input.error?.name ?? input.event ?? "",
    normalizeMessage(input.error?.message ?? input.message),
    stack,
    // With a stack the code location identifies the problem; without one the
    // route is the best remaining signal.
    stack ? "" : normalizeRoute(input.route ?? ""),
  ];
}

export function fingerprint(input: FingerprintInput): string {
  return hash(fingerprintParts(input).join("␟"));
}
