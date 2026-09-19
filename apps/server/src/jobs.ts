import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { log } from "./lib/log.js";
import { metrics } from "./lib/metrics.js";
import { deleteExpiredSessions } from "./services/auth.js";
import { deleteExpiredEvents } from "./services/events.js";
import { closeStaleIncidents, deleteExpiredIncidents, dispatchPendingAlerts } from "./services/incidents.js";

/** Retention and cleanup, so the database cannot grow without bound (IDEA §18). */
export function runHousekeeping(db: Db, config: Config): void {
  try {
    const deleted = deleteExpiredEvents(db, config.retentionDays);
    const deletedIncidents = deleteExpiredIncidents(db, config.retentionDays);
    const sessions = deleteExpiredSessions(db);
    const resolvedIncidents = closeStaleIncidents(db);
    metrics.retentionDeleted += deleted;
    metrics.retentionLastRun = new Date().toISOString();
    metrics.retentionLastError = null;
    if (deleted || deletedIncidents || sessions || resolvedIncidents) {
      log.info("housekeeping", { deletedEvents: deleted, deletedIncidents, deletedSessions: sessions, resolvedIncidents });
    }
    if (config.alertWebhookUrl) void deliverAlerts(db, config.alertWebhookUrl);
    // Keep the WAL from growing between automatic checkpoints, and let SQLite refresh its statistics.
    db.exec("PRAGMA wal_checkpoint(PASSIVE); PRAGMA optimize;");
  } catch (error) {
    metrics.retentionLastError = error instanceof Error ? error.message : String(error);
    log.error("housekeeping failed", { error });
  }
}

let alertDeliveryRunning = false;

async function deliverAlerts(db: Db, webhookUrl: string): Promise<void> {
  if (alertDeliveryRunning) return;
  alertDeliveryRunning = true;
  try {
    const result = await dispatchPendingAlerts(db, webhookUrl);
    if (result.sent || result.failed) log.info("incident alerts dispatched", result);
  } catch (error) {
    log.error("incident alert dispatch failed", { error });
  } finally {
    alertDeliveryRunning = false;
  }
}

export function startHousekeeping(db: Db, config: Config): () => void {
  const first = setTimeout(() => runHousekeeping(db, config), 30_000);
  const timer = setInterval(() => runHousekeeping(db, config), 60 * 60_000);
  const alerts = config.alertWebhookUrl ? setInterval(() => void deliverAlerts(db, config.alertWebhookUrl!), 30_000) : undefined;
  first.unref();
  timer.unref();
  alerts?.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    if (alerts) clearInterval(alerts);
  };
}
