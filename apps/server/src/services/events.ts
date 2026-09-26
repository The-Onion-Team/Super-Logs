import {
  IP_PATTERN,
  LEVEL_RANK,
  LIMITS,
  LEVELS,
  REQUEST_ID_PATTERN,
  SECURITY_SIGNAL_KINDS,
  fingerprint,
  redactEvent,
  truncate,
  type Level,
  type SuperLogsEvent,
} from "@super-logs/shared";
import * as v from "../lib/validate.js";
import { transaction, type Db } from "../db/index.js";
import { recordIncidentEventsWithinTransaction } from "./incidents.js";

/** Over-long short fields are cut rather than rejected: a long route is still a useful log line. */
const optionalShort = v.optional(
  v.map(v.string({ max: LIMITS.maxShortField * 4 }), (value) => truncate(value.trim(), LIMITS.maxShortField)),
);
const correlationId = v.optional(
  v.string({ pattern: REQUEST_ID_PATTERN, patternMessage: "must be 8–128 of [A-Za-z0-9._:-]" }),
);
const tagKey = v.string({
  trim: true,
  min: 1,
  max: LIMITS.maxShortField,
  pattern: /^[\w.:-]+$/,
  patternMessage: "tag keys are [A-Za-z0-9_.:-]",
});

export const eventSchema = v.object({
  timestamp: v.optional(v.string({ max: 40 })),
  level: v.enumOf(LEVELS),
  message: v.string({ min: 1, max: LIMITS.maxMessageLength * 10 }),
  event: optionalShort,
  service: optionalShort,
  environment: optionalShort,
  release: optionalShort,
  host: optionalShort,
  requestId: correlationId,
  sessionId: correlationId,
  userId: optionalShort,
  route: optionalShort,
  method: v.optional(v.string({ max: 16 })),
  httpStatus: v.optional(v.number({ int: true, min: 0, max: 999 })),
  durationMs: v.optional(v.number({ min: 0, max: 86_400_000 })),
  error: v.optional(
    v.object({
      name: v.optional(v.string({ max: LIMITS.maxShortField * 4 })),
      message: v.optional(v.string({ max: LIMITS.maxMessageLength * 10 })),
      stack: v.optional(v.string({ max: LIMITS.maxStackLength * 4 })),
      componentStack: v.optional(v.string({ max: LIMITS.maxStackLength * 4 })),
    }),
  ),
  client: v.optional(v.record(v.string({ max: 40 }), v.string({ max: 400 }))),
  tags: v.optional(
    v.record(tagKey, v.string({ max: LIMITS.maxShortField }), {
      maxEntries: LIMITS.maxTags,
      maxEntriesMessage: `at most ${LIMITS.maxTags} tags`,
    }),
  ),
  metadata: v.optional(v.record(v.string(), v.unknown)),
  security: v.optional(
    v.object({
      signal: v.enumOf(SECURITY_SIGNAL_KINDS),
      ip: v.optional(v.string({ trim: true, max: 45, pattern: IP_PATTERN, patternMessage: "must be an IPv4 or IPv6 address" })),
      userAgent: v.optional(v.map(v.string({ max: 2000 }), (value) => truncate(value, 300))),
      account: v.optional(v.string({ max: 64, pattern: /^[\w.:-]+$/, patternMessage: "must be an opaque id or hash, not an email" })),
    }),
  ),
});

export const batchSchema = v.object({
  events: v.array(v.unknown, { min: 1, max: LIMITS.maxEventsPerBatch }),
});

/** How far an event's own timestamp may be from the receive time before we distrust it. */
const MAX_FUTURE_MS = 5 * 60_000;
const MAX_PAST_MS = 7 * 86_400_000;

export interface StoredEvent {
  id: number;
  projectId: string;
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

const RANK_TO_LEVEL = new Map(Object.entries(LEVEL_RANK).map(([level, rank]) => [rank, level as Level]));

/** Validates, normalises and redacts one event. Returns an error message instead of throwing. */
export function normalizeEvent(input: unknown, receivedAt: number): { ok: true; event: SuperLogsEvent; ts: number } | { ok: false; message: string } {
  const parsed = eventSchema.safeParse(input);
  if (!parsed.ok) {
    const issue = parsed.issues[0];
    return { ok: false, message: issue ? `${issue.path || "event"}: ${issue.message}` : "invalid event" };
  }
  const raw = parsed.value;
  let ts = raw.timestamp ? Date.parse(raw.timestamp) : Number.NaN;
  let metadata = raw.metadata;
  if (Number.isNaN(ts) || ts > receivedAt + MAX_FUTURE_MS || ts < receivedAt - MAX_PAST_MS) {
    // A skewed client clock: order by receive time, keep what the client said.
    if (raw.timestamp) metadata = { ...metadata, _clientTimestamp: raw.timestamp };
    ts = receivedAt;
  }
  if (metadata) {
    const size = Buffer.byteLength(JSON.stringify(metadata));
    if (size > LIMITS.maxMetadataBytes) metadata = { _truncated: true, _originalBytes: size };
  }

  const event = redactEvent({
    ...raw,
    message: truncate(raw.message, LIMITS.maxMessageLength),
    route: raw.route?.split(/[?#]/)[0],
    method: raw.method?.toUpperCase(),
    error: raw.error && {
      name: raw.error.name && truncate(raw.error.name, LIMITS.maxShortField),
      message: raw.error.message && truncate(raw.error.message, LIMITS.maxMessageLength),
      stack: joinStacks(raw.error.stack, raw.error.componentStack),
    },
    metadata,
  } as SuperLogsEvent);
  return { ok: true, event, ts };
}

function joinStacks(stack?: string, componentStack?: string): string | undefined {
  const joined = [stack, componentStack && `Component stack:${componentStack.startsWith("\n") ? "" : "\n"}${componentStack}`]
    .filter(Boolean)
    .join("\n\n");
  return joined ? truncate(joined, LIMITS.maxStackLength) : undefined;
}

export function insertEvents(
  db: Db,
  projectId: string,
  events: { event: SuperLogsEvent; ts: number }[],
  receivedAt: number,
  alertCooldownMs?: number,
): void {
  if (!events.length) return;
  const insert = db.prepare(`
    INSERT INTO events (
      project_id, ts, received_at, level, service, environment, release, host, event, message,
      request_id, session_id, user_id, route, method, http_status, duration_ms,
      error_name, error_message, error_stack, fingerprint, client, tags, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  transaction(db, () => {
    const incidentEvents: { id: number; fingerprint: string | null; level: number; ts: number }[] = [];
    for (const { event: e, ts } of events) {
      // Warnings and above are what incidents are built from (Phase 2).
      const fp = LEVEL_RANK[e.level] >= LEVEL_RANK.warning ? fingerprint(e) : null;
      const result = insert.run(
        projectId,
        ts,
        receivedAt,
        LEVEL_RANK[e.level],
        e.service ?? null,
        e.environment ?? null,
        e.release ?? null,
        e.host ?? null,
        e.event ?? null,
        e.message,
        e.requestId ?? null,
        e.sessionId ?? null,
        e.userId ?? null,
        e.route ?? null,
        e.method ?? null,
        e.httpStatus ?? null,
        e.durationMs ?? null,
        e.error?.name ?? null,
        e.error?.message ?? null,
        e.error?.stack ?? null,
        fp,
        json(e.client),
        json(e.tags),
        json(e.metadata),
      );
      incidentEvents.push({ id: Number(result.lastInsertRowid), fingerprint: fp, level: LEVEL_RANK[e.level], ts });
    }
    recordIncidentEventsWithinTransaction(db, projectId, incidentEvents, { alertCooldownMs, now: receivedAt });
  });
}

function json(value: unknown): string | null {
  return value === undefined || value === null || (typeof value === "object" && Object.keys(value).length === 0)
    ? null
    : JSON.stringify(value);
}

// --- queries ---------------------------------------------------------------

export const eventQuerySchema = v.object({
  level: v.optional(v.enumOf(LEVELS)),
  /** Exact level instead of "this level and above". */
  exactLevel: v.optional(v.enumOf(["1", "true"])),
  service: v.optional(v.string({ max: 200 })),
  environment: v.optional(v.string({ max: 200 })),
  route: v.optional(v.string({ max: 400 })),
  requestId: v.optional(v.string({ max: 128 })),
  sessionId: v.optional(v.string({ max: 128 })),
  userId: v.optional(v.string({ max: 200 })),
  event: v.optional(v.string({ max: 200 })),
  fingerprint: v.optional(v.string({ max: 64 })),
  /** `key:value` */
  tag: v.optional(v.string({ max: 300, pattern: /^[\w.:-]+:.+$/, patternMessage: "must be key:value" })),
  from: v.optional(v.string({ max: 40 })),
  to: v.optional(v.string({ max: 40 })),
  q: v.optional(v.string({ max: 200 })),
  cursor: v.optional(v.string({ pattern: /^\d+:\d+$/, patternMessage: "must be a cursor from a previous page" })),
  limit: v.withDefault(v.number({ coerce: true, int: true, min: 1, max: 500 }), 100),
});
export type EventQuery = v.Infer<typeof eventQuerySchema>;

interface EventRow {
  id: number;
  project_id: string;
  ts: number;
  received_at: number;
  level: number;
  service: string | null;
  environment: string | null;
  release: string | null;
  host: string | null;
  event: string | null;
  message: string;
  request_id: string | null;
  session_id: string | null;
  user_id: string | null;
  route: string | null;
  method: string | null;
  http_status: number | null;
  duration_ms: number | null;
  error_name: string | null;
  error_message: string | null;
  error_stack: string | null;
  fingerprint: string | null;
  client: string | null;
  tags: string | null;
  metadata: string | null;
}

/** Turns free text into a safe FTS5 query: every word must match, as a prefix. */
export function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 8) ?? [];
  return words.length ? words.map((word) => `"${word}"*`).join(" AND ") : null;
}

export function queryEvents(db: Db, projectId: string, query: EventQuery): { events: StoredEvent[]; nextCursor: string | null } {
  const where: string[] = ["e.project_id = ?"];
  const params: (string | number)[] = [projectId];

  if (query.level) {
    where.push(query.exactLevel ? "e.level = ?" : "e.level >= ?");
    params.push(LEVEL_RANK[query.level]);
  }
  const exact: [keyof EventQuery, string][] = [
    ["service", "service"],
    ["environment", "environment"],
    ["requestId", "request_id"],
    ["sessionId", "session_id"],
    ["userId", "user_id"],
    ["event", "event"],
    ["fingerprint", "fingerprint"],
  ];
  for (const [key, column] of exact) {
    const value = query[key];
    if (typeof value === "string" && value) {
      where.push(`e.${column} = ?`);
      params.push(value);
    }
  }
  if (query.route) {
    // `*` is a wildcard: `/league/*`.
    where.push("e.route LIKE ? ESCAPE '\\'");
    params.push(query.route.replace(/[\\%_]/g, "\\$&").replace(/\*/g, "%"));
  }
  if (query.tag) {
    const split = query.tag.indexOf(":");
    where.push("json_extract(e.tags, ?) = ?");
    params.push(`$."${query.tag.slice(0, split).replace(/"/g, "")}"`, query.tag.slice(split + 1));
  }
  const from = query.from ? Date.parse(query.from) : Number.NaN;
  if (!Number.isNaN(from)) {
    where.push("e.ts >= ?");
    params.push(from);
  }
  const to = query.to ? Date.parse(query.to) : Number.NaN;
  if (!Number.isNaN(to)) {
    where.push("e.ts <= ?");
    params.push(to);
  }
  const fts = query.q ? ftsQuery(query.q) : null;
  if (fts) {
    where.push("e.id IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)");
    params.push(fts);
  }
  if (query.cursor) {
    const [ts, id] = query.cursor.split(":").map(Number) as [number, number];
    where.push("(e.ts < ? OR (e.ts = ? AND e.id < ?))");
    params.push(ts, ts, id);
  }

  const rows = db
    .prepare(`SELECT e.* FROM events e WHERE ${where.join(" AND ")} ORDER BY e.ts DESC, e.id DESC LIMIT ?`)
    .all(...params, query.limit + 1) as unknown as EventRow[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    events: page.map(toStored),
    nextCursor: rows.length > query.limit && last ? `${last.ts}:${last.id}` : null,
  };
}

export function getEvent(db: Db, projectId: string, id: number): StoredEvent | null {
  const row = db.prepare("SELECT * FROM events WHERE project_id = ? AND id = ?").get(projectId, id) as EventRow | undefined;
  return row ? toStored(row) : null;
}

/** Distinct values for the filter dropdowns, from the last 7 days. */
export function eventFacets(db: Db, projectId: string): { services: string[]; environments: string[]; tagKeys: string[] } {
  const since = Date.now() - 7 * 86_400_000;
  const distinct = (column: string) =>
    (
      db
        .prepare(`SELECT DISTINCT ${column} AS value FROM events WHERE project_id = ? AND ts >= ? AND ${column} IS NOT NULL LIMIT 100`)
        .all(projectId, since) as { value: string }[]
    )
      .map((row) => row.value)
      .sort();
  const tagKeys = (
    db
      .prepare(
        `SELECT DISTINCT j.key AS value FROM (SELECT tags FROM events WHERE project_id = ? AND ts >= ? AND tags IS NOT NULL ORDER BY ts DESC LIMIT 2000) t, json_each(t.tags) j LIMIT 50`,
      )
      .all(projectId, since) as { value: string }[]
  )
    .map((row) => row.value)
    .sort();
  return { services: distinct("service"), environments: distinct("environment"), tagKeys };
}

/** Counts per level over a window, plus an hourly error histogram, for the logs header. */
export function eventStats(db: Db, projectId: string, windowHours = 24) {
  const now = Date.now();
  const since = now - windowHours * 3_600_000;
  const byLevel = Object.fromEntries(LEVELS.map((level) => [level, 0])) as Record<Level, number>;
  for (const row of db
    .prepare("SELECT level, COUNT(*) AS n FROM events WHERE project_id = ? AND ts >= ? GROUP BY level")
    .all(projectId, since) as { level: number; n: number }[]) {
    const level = RANK_TO_LEVEL.get(row.level);
    if (level) byLevel[level] = row.n;
  }
  const buckets = db
    .prepare(
      `SELECT CAST((ts - ?) / 3600000 AS INTEGER) AS bucket,
              SUM(CASE WHEN level >= ? THEN 1 ELSE 0 END) AS errors,
              COUNT(*) AS total
       FROM events WHERE project_id = ? AND ts >= ? GROUP BY bucket`,
    )
    .all(since, LEVEL_RANK.error, projectId, since) as { bucket: number; errors: number; total: number }[];
  const hourly = Array.from({ length: windowHours }, (_, i) => ({
    start: new Date(since + i * 3_600_000).toISOString(),
    errors: 0,
    total: 0,
  }));
  for (const b of buckets) {
    // node:sqlite binds JS numbers as REAL, so never trust the division to be integral.
    const slot = hourly[Math.min(Math.max(Math.floor(b.bucket), 0), windowHours - 1)];
    if (slot) {
      slot.errors += b.errors;
      slot.total += b.total;
    }
  }
  return { windowHours, byLevel, hourly, latency: latencyStats(db, projectId, windowHours, since), groups: errorGroups(db, projectId, windowHours, since) };
}

export interface LatencyBucket {
  start: string;
  /** Null where the hour held no event carrying a duration. */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  count: number;
}

/**
 * Hourly p50/p95/p99 of `duration_ms`. SQLite has no percentile function, so the
 * rows are ranked per bucket and the nearest-rank value is picked out.
 */
export function latencyStats(db: Db, projectId: string, windowHours: number, since: number): LatencyBucket[] {
  const rows = db
    .prepare(
      `WITH timed AS (
         SELECT CAST((ts - ?) / 3600000 AS INTEGER) AS bucket, duration_ms
         FROM events
         WHERE project_id = ? AND ts >= ? AND duration_ms IS NOT NULL
       ),
       ranked AS (
         SELECT bucket, duration_ms,
                ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY duration_ms) AS rn,
                COUNT(*) OVER (PARTITION BY bucket) AS n
         FROM timed
       )
       SELECT bucket, n,
              MAX(CASE WHEN rn = MAX(1, CAST(ROUND(n * 0.50) AS INTEGER)) THEN duration_ms END) AS p50,
              MAX(CASE WHEN rn = MAX(1, CAST(ROUND(n * 0.95) AS INTEGER)) THEN duration_ms END) AS p95,
              MAX(CASE WHEN rn = MAX(1, CAST(ROUND(n * 0.99) AS INTEGER)) THEN duration_ms END) AS p99
       FROM ranked GROUP BY bucket, n`,
    )
    .all(since, projectId, since) as { bucket: number; n: number; p50: number | null; p95: number | null; p99: number | null }[];

  const buckets: LatencyBucket[] = Array.from({ length: windowHours }, (_, i) => ({
    start: new Date(since + i * 3_600_000).toISOString(),
    p50: null,
    p95: null,
    p99: null,
    count: 0,
  }));
  for (const row of rows) {
    const slot = buckets[Math.min(Math.max(Math.floor(row.bucket), 0), windowHours - 1)];
    if (!slot) continue;
    slot.p50 = row.p50;
    slot.p95 = row.p95;
    slot.p99 = row.p99;
    slot.count = row.n;
  }
  return buckets;
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
  /** Per-hour counts across the same window, for the row's sparkline. */
  spark: number[];
}

/**
 * The loudest error groups in the window — what is broken, in priority order.
 * The chronological stream cannot answer this: one exception repeated 4,000
 * times looks like 4,000 problems.
 */
export function errorGroups(db: Db, projectId: string, windowHours: number, since: number, limit = 10): ErrorGroup[] {
  const totals = db
    .prepare(
      `SELECT fingerprint, COUNT(*) AS n, MIN(ts) AS first_seen, MAX(ts) AS last_seen, MAX(level) AS level
       FROM events
       WHERE project_id = ? AND ts >= ? AND level >= ? AND fingerprint IS NOT NULL
       GROUP BY fingerprint
       ORDER BY n DESC
       LIMIT ?`,
    )
    .all(projectId, since, LEVEL_RANK.error, limit) as {
    fingerprint: string;
    n: number;
    first_seen: number;
    last_seen: number;
    level: number;
  }[];

  // One indexed lookup per group for a representative event, and one for the
  // sparkline; both ride events_fingerprint and stay tiny at limit = 10.
  const latest = db.prepare(
    "SELECT error_name, error_message, message, service, route FROM events WHERE project_id = ? AND fingerprint = ? ORDER BY ts DESC LIMIT 1",
  );
  const perHour = db.prepare(
    `SELECT CAST((ts - ?) / 3600000 AS INTEGER) AS bucket, COUNT(*) AS n
     FROM events WHERE project_id = ? AND fingerprint = ? AND ts >= ? GROUP BY bucket`,
  );

  return totals.map((row) => {
    const sample = latest.get(projectId, row.fingerprint) as
      | { error_name: string | null; error_message: string | null; message: string; service: string | null; route: string | null }
      | undefined;
    const spark = new Array<number>(windowHours).fill(0);
    for (const bucket of perHour.all(since, projectId, row.fingerprint, since) as { bucket: number; n: number }[]) {
      const slot = Math.min(Math.max(Math.floor(bucket.bucket), 0), windowHours - 1);
      spark[slot] = (spark[slot] ?? 0) + bucket.n;
    }
    return {
      fingerprint: row.fingerprint,
      title: sample?.error_name ?? sample?.message ?? "Error",
      message: sample?.error_message ?? sample?.message ?? "",
      level: RANK_TO_LEVEL.get(row.level) ?? "error",
      service: sample?.service ?? null,
      route: sample?.route ?? null,
      count: row.n,
      firstSeen: new Date(row.first_seen).toISOString(),
      lastSeen: new Date(row.last_seen).toISOString(),
      spark,
    };
  });
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function toStored(row: EventRow): StoredEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    timestamp: new Date(row.ts).toISOString(),
    receivedAt: new Date(row.received_at).toISOString(),
    level: RANK_TO_LEVEL.get(row.level) ?? "info",
    message: row.message,
    event: row.event,
    service: row.service,
    environment: row.environment,
    release: row.release,
    host: row.host,
    requestId: row.request_id,
    sessionId: row.session_id,
    userId: row.user_id,
    route: row.route,
    method: row.method,
    httpStatus: row.http_status,
    durationMs: row.duration_ms,
    error:
      row.error_name || row.error_message || row.error_stack
        ? { name: row.error_name, message: row.error_message, stack: row.error_stack }
        : null,
    fingerprint: row.fingerprint,
    client: parseJson(row.client),
    tags: parseJson(row.tags),
    metadata: parseJson(row.metadata),
  };
}

/** Deletes raw events older than the retention window, in small batches. */
export function deleteExpiredEvents(db: Db, retentionDays: number, now = Date.now(), batch = 5_000): number {
  const cutoff = now - retentionDays * 86_400_000;
  const statement = db.prepare(
    "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE received_at < ? LIMIT ?)",
  );
  let total = 0;
  for (;;) {
    const { changes } = statement.run(cutoff, batch);
    total += Number(changes);
    if (Number(changes) < batch) break;
  }
  return total;
}
