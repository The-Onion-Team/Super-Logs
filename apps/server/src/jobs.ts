import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { log } from "./lib/log.js";
import { metrics } from "./lib/metrics.js";
import { deleteExpiredSessions } from "./services/auth.js";
import { deleteExpiredEvents } from "./services/events.js";
import { closeStaleIncidents, deleteExpiredIncidents, dispatchPendingAlerts } from "./services/incidents.js";
import { channelsFromConfig, type AlertChannel } from "./services/alerts.js";
import { projectChannels } from "./services/channels.js";

/**
 * Alerts go to the channels set in the environment (which cover every project)
 * plus whatever that project configured in the dashboard.
 */
function channelResolver(db: Db, config: Config): (projectId: string) => AlertChannel[] {
  const global = channelsFromConfig(config);
  return (projectId) => [...global, ...projectChannels(db, projectId, config)];
}

/** Retention and cleanup, so the database cannot grow without bound (IDEA §18). */
export function runHousekeeping(db: Db, config: Config, resolve = channelResolver(db, config)): void {
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
    void deliverAlerts(db, resolve);
    // Keep the WAL from growing between automatic checkpoints, and let SQLite refresh its statistics.
    db.exec("PRAGMA wal_checkpoint(PASSIVE); PRAGMA optimize;");
  } catch (error) {
    metrics.retentionLastError = error instanceof Error ? error.message : String(error);
    log.error("housekeeping failed", { error });
  }
}

let alertDeliveryRunning = false;

async function deliverAlerts(db: Db, resolve: (projectId: string) => AlertChannel[]): Promise<void> {
  if (alertDeliveryRunning) return;
  alertDeliveryRunning = true;
  try {
    const result = await dispatchPendingAlerts(db, resolve);
    metrics.alertsSent += result.sent;
    metrics.alertsFailed += result.failed;
    if (result.sent || result.failed) log.info("incident alerts dispatched", result);
  } catch (error) {
    log.error("incident alert dispatch failed", { error });
  } finally {
    alertDeliveryRunning = false;
  }
}

export function startHousekeeping(db: Db, config: Config): () => void {
  const resolve = channelResolver(db, config);
  const fromEnv = channelsFromConfig(config);
  if (fromEnv.length) log.info("incident alert channels enabled", { channels: fromEnv.map((channel) => channel.name) });
  const first = setTimeout(() => runHousekeeping(db, config, resolve), 30_000);
  const timer = setInterval(() => runHousekeeping(db, config, resolve), 60 * 60_000);
  // Always running: a project can add a channel from the dashboard at any time.
  const alerts = setInterval(() => void deliverAlerts(db, resolve), 30_000);
  first.unref();
  timer.unref();
  alerts.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    clearInterval(alerts);
  };
}
