/**
 * The Super-Logs event: one structured JSON record, whoever produced it.
 *
 * Only `level` and `message` are required from a producer. The SDKs fill in
 * the rest they can know (timestamp, service, environment, request/session
 * correlation), and the server stamps what only it can know (project,
 * received time, fingerprint).
 */

export const LEVELS = ["debug", "info", "warning", "error", "critical"] as const;
export type Level = (typeof LEVELS)[number];

/** Numeric severity, stored alongside the name so "error and above" is one comparison. */
export const LEVEL_RANK: Record<Level, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
  critical: 50,
};

export function isLevel(value: unknown): value is Level {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value);
}

export function levelAtLeast(level: Level, min: Level): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}

export interface EventError {
  name?: string;
  message?: string;
  stack?: string;
  /** Extra context attached to the error (e.g. React's component stack). */
  componentStack?: string;
}

/** Technical client context. Never personal data. */
export interface ClientInfo {
  browser?: string;
  browserVersion?: string;
  os?: string;
  deviceClass?: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
  viewport?: string;
  screen?: string;
  language?: string;
  userAgent?: string;
}

export interface SuperLogsEvent {
  /** ISO-8601. Defaults to the time the server received the event. */
  timestamp?: string;
  level: Level;
  message: string;
  /** A stable machine name for what happened, e.g. `api_request_failed`. */
  event?: string;

  service?: string;
  environment?: string;
  /** Application version or git commit. */
  release?: string;
  /** Server / container identifier. */
  host?: string;

  requestId?: string;
  sessionId?: string;
  /** An opaque internal identifier or hash — never an email or a name. */
  userId?: string;

  /** Page (browser) or route pattern (server). No query strings. */
  route?: string;
  method?: string;
  httpStatus?: number;
  durationMs?: number;

  error?: EventError;
  client?: ClientInfo;
  /** Short, low-cardinality labels to filter by, e.g. `{ league: "main" }`. */
  tags?: Record<string, string>;
  /** Anything else. Redacted before it leaves the SDK and again on ingest. */
  metadata?: Record<string, unknown>;
}

/** The body of `POST /api/ingest`. */
export interface IngestBatch {
  events: SuperLogsEvent[];
}

export interface IngestResult {
  accepted: number;
  rejected: number;
  errors?: { index: number; message: string }[];
}

/** Hard limits, enforced by the server and respected by the SDKs. */
export const LIMITS = {
  maxEventsPerBatch: 100,
  maxBatchBytes: 512 * 1024,
  maxMessageLength: 2_000,
  maxStackLength: 16_000,
  maxMetadataBytes: 16 * 1024,
  maxTags: 20,
  maxShortField: 200,
} as const;

/** Header carrying the correlation id between browser, app server and Super-Logs. */
export const REQUEST_ID_HEADER = "x-request-id";

/** Request ids we accept from the outside: short, and nothing that could smuggle markup or newlines. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
