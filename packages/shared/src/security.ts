/**
 * Security signals: the raw facts detection is built from.
 *
 * A signal is one suspicious-looking request (a failed sign-in, a probe for
 * `/.env`, a 5xx) together with the client address it came from. Signals are
 * the only place Super-Logs stores an IP address: they live in their own table
 * with a short retention and never become ordinary log events.
 */

export const SECURITY_SIGNAL_KINDS = [
  /** 401 or 403 from the app. */
  "auth_failed",
  /** The app said a sign-in failed (it may still have answered 200). */
  "login_failed",
  /** A request for a path no real user asks for: `/.env`, `/wp-login.php`, … */
  "probe",
  /** 429 from the app. */
  "rate_limited",
  /** 5xx from the app. Many from one address in a short time looks like fuzzing. */
  "server_error",
] as const;
export type SecuritySignalKind = (typeof SECURITY_SIGNAL_KINDS)[number];

export function isSecuritySignalKind(value: unknown): value is SecuritySignalKind {
  return typeof value === "string" && (SECURITY_SIGNAL_KINDS as readonly string[]).includes(value);
}

/** What a producer attaches to an event to make it a signal instead of a log line. */
export interface SecurityInfo {
  signal: SecuritySignalKind;
  /** The client address, as the app's trusted proxy reported it. */
  ip?: string;
  userAgent?: string;
  /** An opaque hash of the account a sign-in was attempted for. Never an email. */
  account?: string;
}

/**
 * Paths scanners try on every server on the internet. Matched against the
 * path only (no query string), case-insensitively. A Node app has no business
 * serving any of them, so a hit is a strong signal on its own.
 */
export const PROBE_PATTERNS: readonly RegExp[] = [
  /\/\.env(?:\.|\/|$)/i,
  /\/\.git(?:\/|$)/i,
  /\/\.(?:aws|ssh|svn|hg|docker|vscode|idea)(?:\/|$)/i,
  /\/\.(?:htaccess|htpasswd|ds_store|npmrc|bash_history)$/i,
  /\/wp-(?:admin|login|content|includes|config)/i,
  /\/xmlrpc\.php$/i,
  /\/(?:phpmyadmin|pma|myadmin|adminer)(?:\/|\.php|$)/i,
  /\/server-status$/i,
  /\/actuator(?:\/|$)/i,
  /\/cgi-bin\//i,
  /\/(?:vendor\/phpunit|boaform|HNAP1|owa\/auth)/i,
  /\.(?:php\d?|asp|aspx|jsp|cgi)$/i,
  /\.(?:sql|bak|old|swp)$/i,
  // Path traversal, raw or percent-encoded (dots or the slash after them).
  /(?:^|\/)\.\.(?:\/|\\|$)|\.\.(?:%2f|%5c)|%2e%2e|%252e/i,
];

export function isProbePath(path: string): boolean {
  return PROBE_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Decides whether a finished response is worth reporting as a signal. Probes
 * win over the status: `/.env` answering 404 is still a probe.
 */
export function classifyResponse(path: string, status: number): SecuritySignalKind | null {
  if (isProbePath(path)) return "probe";
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "server_error";
  return null;
}

/**
 * A plausible IPv4 or IPv6 address, without zone ids or ports. Loose on
 * purpose (it is a sanity check, not a parser), but strict enough that the
 * field cannot carry markup or arbitrary text.
 */
export const IP_PATTERN = /^(?:\d{1,3}(?:\.\d{1,3}){3}|(?=[^:]*:)[0-9a-f:]{2,39}(?:\d{1,3}(?:\.\d{1,3}){3})?)$/i;
