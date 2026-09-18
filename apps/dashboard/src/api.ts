import type { Level } from "@super-logs/shared";

export type { Level };

export interface User {
  id: string;
  email: string;
  role: "admin" | "viewer";
  mustChangePassword: boolean;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface StoredEvent {
  id: number;
  timestamp: string;
  receivedAt: string;
  level: Level;
  message: string;
  event: string | null;
  service: string | null;
  environment: string | null;
  release: string | null;
  host: string | null;
  requestId: string | null;
  sessionId: string | null;
  userId: string | null;
  route: string | null;
  method: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  error: { name: string | null; message: string | null; stack: string | null } | null;
  fingerprint: string | null;
  client: Record<string, string> | null;
  tags: Record<string, string> | null;
  metadata: Record<string, unknown> | null;
}

export interface LatencyBucket {
  start: string;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  count: number;
}

export interface ErrorGroup {
  fingerprint: string;
  title: string;
  message: string;
  level: Level;
  service: string | null;
  route: string | null;
  count: number;
  firstSeen: string;
  lastSeen: string;
  spark: number[];
}

export interface Stats {
  windowHours: number;
  byLevel: Record<Level, number>;
  hourly: { start: string; errors: number; total: number }[];
  latency: LatencyBucket[];
  groups: ErrorGroup[];
}

export interface Facets {
  services: string[];
  environments: string[];
  tagKeys: string[];
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Listeners for "the session is gone" so the app can return to sign-in. */
const unauthenticated = new Set<() => void>();
export function onUnauthenticated(fn: () => void): () => void {
  unauthenticated.add(fn);
  return () => unauthenticated.delete(fn);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    signal: init.signal,
    headers: {
      "content-type": "application/json",
      // Required by the server on every write: a cross-site form cannot set it.
      "x-super-logs-csrf": "1",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith("/auth/login")) unauthenticated.forEach((fn) => fn());
    throw new ApiError(response.status, data.error ?? `http_${response.status}`, data.message);
  }
  return data as T;
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: "Wrong email or password.",
  too_many_attempts: "Too many attempts. Wait a few minutes and try again.",
  wrong_password: "The current password is wrong.",
  password_too_short: "The new password must be at least 12 characters.",
  password_unchanged: "The new password must be different.",
  invalid_name: "Enter a name (up to 80 characters).",
  confirmation_required: "Type the project slug to confirm.",
  forbidden: "Only administrators can do that.",
  csrf_rejected: "The request was blocked. Reload the page and try again.",
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return MESSAGES[error.code] ?? error.message ?? "Something went wrong.";
  if (error instanceof DOMException && error.name === "AbortError") return "";
  return "Super-Logs could not be reached.";
}
