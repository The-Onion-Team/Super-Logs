import { LEVEL_RANK, type Level } from "@super-logs/shared";
import { transaction, type Db } from "../db/index.js";
import { newId } from "../lib/crypto.js";
import type { AlertChannel, IncidentAlert } from "./alerts.js";

/** An incident stays open while the same problem keeps occurring in this window. */
export const INCIDENT_WINDOW_MS = 30 * 60_000;
export const DEFAULT_ALERT_COOLDOWN_MS = 15 * 60_000;

export interface IncidentEvent {
  id: number;
  fingerprint: string | null;
  level: number;
  ts: number;
}

export interface Incident {
  id: string;
  projectId: string;
  fingerprint: string;
  status: "open" | "resolved";
  firstSeen: string;
  lastSeen: string;
  eventCount: number;
  level: Level;
  title: string;
  message: string;
  service: string | null;
  route: string | null;
  alertCount: number;
  lastAlertAt: string | null;
}

export interface IncidentOptions {
  alertCooldownMs?: number;
  now?: number;
}

interface IncidentRow {
  id: string;
  project_id: string;
  fingerprint: string;
  status: "open" | "resolved";
  first_seen_at: number;
  last_seen_at: number;
  event_count: number;
  max_level: number;
  error_name: string | null;
  error_message: string | null;
  sample_message: string | null;
  service: string | null;
  route: string | null;
  alert_count: number;
  last_alert_at: number | null;
}

interface OpenIncidentRow {
  id: string;
  first_seen_at: number;
  last_seen_at: number;
}

/**
 * Associates newly stored events with incidents and queues at most one alert
 * per incident/cooldown window. Call this inside the event-write transaction.
 */
export function recordIncidentEventsWithinTransaction(
  db: Db,
  projectId: string,
  events: IncidentEvent[],
  options: IncidentOptions = {},
): void {
  const now = options.now ?? Date.now();
  const alertCooldownMs = options.alertCooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
  const candidates = events
    .filter((event) => event.fingerprint && event.level >= LEVEL_RANK.warning)
    .sort((a, b) => a.ts - b.ts || a.id - b.id) as (IncidentEvent & { fingerprint: string })[];

  const findOpen = db.prepare(
    "SELECT id, first_seen_at, last_seen_at FROM incidents WHERE project_id = ? AND fingerprint = ? AND status = 'open'",
  );
  const resolve = db.prepare("UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'open'");
  const create = db.prepare(
    `INSERT INTO incidents (
       id, project_id, fingerprint, status, first_seen_at, last_seen_at,
       event_count, max_level, created_at
     ) VALUES (?, ?, ?, 'open', ?, ?, 1, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE incidents
     SET first_seen_at = MIN(first_seen_at, ?),
         last_seen_at = MAX(last_seen_at, ?),
         event_count = event_count + 1,
         max_level = MAX(max_level, ?)
     WHERE id = ?`,
  );
  const link = db.prepare("INSERT OR IGNORE INTO incident_events (incident_id, event_id) VALUES (?, ?)");
  const lastAlert = db.prepare("SELECT MAX(created_at) AS created_at FROM incident_alerts WHERE incident_id = ?");
  const queueAlert = db.prepare(
    `INSERT OR IGNORE INTO incident_alerts (incident_id, dedupe_key, created_at)
     VALUES (?, ?, ?)`,
  );

  for (const event of candidates) {
    const current = findOpen.get(projectId, event.fingerprint) as OpenIncidentRow | undefined;
    let incidentId: string;

    if (current && event.ts < current.first_seen_at - INCIDENT_WINDOW_MS) {
      // A late event must not reopen an incident from the past or move the
      // current incident's timeline backwards.
      continue;
    }

    if (!current || Math.abs(event.ts - current.last_seen_at) > INCIDENT_WINDOW_MS) {
      if (current) resolve.run(now, current.id);
      incidentId = newId("inc");
      create.run(incidentId, projectId, event.fingerprint, event.ts, event.ts, event.level, now);
    } else {
      incidentId = current.id;
      update.run(event.ts, event.ts, event.level, incidentId);
    }

    link.run(incidentId, event.id);
    const previousAlert = (lastAlert.get(incidentId) as { created_at: number | null }).created_at;
    if (previousAlert === null || now - previousAlert >= alertCooldownMs) {
      // The timestamp is intentionally the dedupe key: the cooldown is
      // relative to the last queued alert, not to fixed wall-clock buckets.
      queueAlert.run(incidentId, String(now), now);
    }
  }
}

/** Public wrapper for housekeeping, migrations, and tests that process events after insertion. */
export function recordIncidentEvents(db: Db, projectId: string, events: IncidentEvent[], options: IncidentOptions = {}): void {
  transaction(db, () => recordIncidentEventsWithinTransaction(db, projectId, events, options));
}

/** Marks quiet incidents resolved. The operation is idempotent and cheap on the indexed status column. */
export function closeStaleIncidents(db: Db, now = Date.now()): number {
  const result = db
    .prepare(
      `UPDATE incidents
       SET status = 'resolved', resolved_at = ?
       WHERE status = 'open' AND last_seen_at < ?`,
    )
    .run(now, now - INCIDENT_WINDOW_MS);
  return Number(result.changes);
}

export function deleteExpiredIncidents(db: Db, retentionDays: number, now = Date.now()): number {
  const cutoff = now - retentionDays * 86_400_000;
  const result = db.prepare("DELETE FROM incidents WHERE status = 'resolved' AND last_seen_at < ?").run(cutoff);
  return Number(result.changes);
}

export function listIncidents(
  db: Db,
  projectId: string,
  options: { status?: "open" | "resolved" | "all"; limit?: number; incidentId?: string } = {},
): Incident[] {
  const status = options.status ?? "open";
  const limit = Math.min(100, Math.max(1, options.limit ?? 20));
  const where = ["i.project_id = ?"];
  const params: (string | number)[] = [projectId];
  if (options.incidentId) {
    where.push("i.id = ?");
    params.push(options.incidentId);
  }
  if (status !== "all") {
    where.push("i.status = ?");
    params.push(status);
  }
  const rows = db
    .prepare(
      `SELECT i.id, i.project_id, i.fingerprint, i.status, i.first_seen_at, i.last_seen_at,
              i.event_count, i.max_level,
              sample.error_name, sample.error_message, sample.message AS sample_message,
              sample.service, sample.route,
              (SELECT COUNT(*) FROM incident_alerts a WHERE a.incident_id = i.id) AS alert_count,
              (SELECT MAX(created_at) FROM incident_alerts a WHERE a.incident_id = i.id) AS last_alert_at
       FROM incidents i
       LEFT JOIN events sample ON sample.id = (
         SELECT ie.event_id
         FROM incident_events ie
         JOIN events e ON e.id = ie.event_id
         WHERE ie.incident_id = i.id
         ORDER BY e.ts DESC, e.id DESC
         LIMIT 1
       )
       WHERE ${where.join(" AND ")}
       ORDER BY CASE i.status WHEN 'open' THEN 0 ELSE 1 END, i.last_seen_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as unknown as IncidentRow[];
  return rows.map(toIncident);
}

export function getIncident(db: Db, projectId: string, incidentId: string): Incident | null {
  const incident = listIncidents(db, projectId, { status: "all", incidentId, limit: 1 })[0];
  return incident ?? null;
}

export function resolveIncident(db: Db, projectId: string, incidentId: string, now = Date.now()): boolean {
  const result = db
    .prepare("UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ? AND project_id = ? AND status = 'open'")
    .run(now, incidentId, projectId);
  return Number(result.changes) > 0;
}

interface PendingAlertRow {
  alert_id: number;
  incident_id: string;
  project_id: string;
  project_name: string;
  fingerprint: string;
  status: "open" | "resolved";
  event_count: number;
  max_level: number;
  first_seen_at: number;
  last_seen_at: number;
  error_name: string | null;
  error_message: string | null;
  message: string | null;
  service: string | null;
  route: string | null;
}

/** Dispatch rounds an alert gets before it is abandoned. */
const MAX_ALERT_ATTEMPTS = 5;

/** Resolves the channels an alert should go to, given the project it belongs to. */
export type ChannelResolver = (projectId: string) => AlertChannel[];

/**
 * Delivers queued alerts to every channel configured for their project,
 * retrying failures. Delivery is recorded per channel, so a channel that
 * already succeeded is never asked to send the same alert again when another
 * one is still failing.
 */
export async function dispatchPendingAlerts(db: Db, resolve: ChannelResolver, limit = 20): Promise<{ sent: number; failed: number }> {
  const rows = db
    .prepare(
      `SELECT a.id AS alert_id,
              i.id AS incident_id, i.project_id, p.name AS project_name, i.fingerprint, i.status,
              i.event_count, i.max_level, i.first_seen_at, i.last_seen_at,
              sample.error_name, sample.error_message, sample.message,
              sample.service, sample.route
       FROM incident_alerts a
       JOIN incidents i ON i.id = a.incident_id
       JOIN projects p ON p.id = i.project_id
       LEFT JOIN events sample ON sample.id = (
         SELECT ie.event_id
         FROM incident_events ie
         JOIN events e ON e.id = ie.event_id
         WHERE ie.incident_id = i.id
         ORDER BY e.ts DESC, e.id DESC
         LIMIT 1
       )
       WHERE a.sent_at IS NULL AND a.attempts < ${MAX_ALERT_ATTEMPTS}
       ORDER BY a.created_at
       LIMIT ?`,
    )
    .all(limit) as unknown as PendingAlertRow[];

  const delivered = db.prepare("SELECT channel FROM incident_alert_deliveries WHERE alert_id = ? AND sent_at IS NOT NULL");
  const recordSent = db.prepare(
    `INSERT INTO incident_alert_deliveries (alert_id, channel, sent_at, attempts)
     VALUES (?, ?, ?, 1)
     ON CONFLICT (alert_id, channel)
     DO UPDATE SET sent_at = excluded.sent_at, attempts = attempts + 1, last_error = NULL`,
  );
  const recordFailure = db.prepare(
    `INSERT INTO incident_alert_deliveries (alert_id, channel, attempts, last_error)
     VALUES (?, ?, 1, ?)
     ON CONFLICT (alert_id, channel)
     DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error`,
  );
  const settle = db.prepare("UPDATE incident_alerts SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?");
  const retryLater = db.prepare("UPDATE incident_alerts SET attempts = attempts + 1, last_error = ? WHERE id = ?");

  let sent = 0;
  let failed = 0;

  // One lookup per project per round, not per alert.
  const byProject = new Map<string, AlertChannel[]>();
  const channelsFor = (projectId: string): AlertChannel[] => {
    let channels = byProject.get(projectId);
    if (!channels) {
      channels = resolve(projectId);
      byProject.set(projectId, channels);
    }
    return channels;
  };

  for (const row of rows) {
    const channels = channelsFor(row.project_id);
    if (channels.length === 0) {
      // Nowhere to send it. Settle it rather than leave it pending: an alert
      // that surfaced hours later, because a channel was added in the
      // meantime, is noise rather than news.
      settle.run(Date.now(), row.alert_id);
      continue;
    }

    const alert = toAlert(row);
    const done = new Set((delivered.all(row.alert_id) as unknown as { channel: string }[]).map((delivery) => delivery.channel));
    const errors: string[] = [];

    for (const channel of channels) {
      if (done.has(channel.name)) continue;
      if (channel.accepts && !channel.accepts(alert)) {
        // Below this channel's threshold: settle it, or the alert would retry
        // forever waiting for a delivery that is never going to happen.
        recordSent.run(row.alert_id, channel.name, Date.now());
        continue;
      }
      try {
        await channel.send(alert);
        recordSent.run(row.alert_id, channel.name, Date.now());
        sent++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordFailure.run(row.alert_id, channel.name, message.slice(0, 500));
        errors.push(`${channel.name}: ${message}`);
        failed++;
      }
    }

    if (errors.length === 0) settle.run(Date.now(), row.alert_id);
    else retryLater.run(errors.join("; ").slice(0, 500), row.alert_id);
  }
  return { sent, failed };
}

function toAlert(row: PendingAlertRow): IncidentAlert {
  return {
    alertId: row.alert_id,
    id: row.incident_id,
    projectId: row.project_id,
    projectName: row.project_name,
    fingerprint: row.fingerprint,
    status: row.status,
    level: levelName(row.max_level),
    eventCount: row.event_count,
    firstSeen: new Date(row.first_seen_at).toISOString(),
    lastSeen: new Date(row.last_seen_at).toISOString(),
    title: row.error_name ?? row.message ?? "Incident",
    message: row.error_message ?? row.message ?? "",
    service: row.service,
    route: row.route,
  };
}

function toIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    projectId: row.project_id,
    fingerprint: row.fingerprint,
    status: row.status,
    firstSeen: new Date(row.first_seen_at).toISOString(),
    lastSeen: new Date(row.last_seen_at).toISOString(),
    eventCount: row.event_count,
    level: levelName(row.max_level),
    title: row.error_name ?? row.sample_message ?? "Incident",
    message: row.error_message ?? row.sample_message ?? "",
    service: row.service,
    route: row.route,
    alertCount: row.alert_count,
    lastAlertAt: row.last_alert_at === null ? null : new Date(row.last_alert_at).toISOString(),
  };
}

function levelName(rank: number): Level {
  if (rank >= LEVEL_RANK.critical) return "critical";
  if (rank >= LEVEL_RANK.error) return "error";
  if (rank >= LEVEL_RANK.warning) return "warning";
  return "info";
}
