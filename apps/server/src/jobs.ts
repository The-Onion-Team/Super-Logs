import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { log } from "./lib/log.js";
import { metrics } from "./lib/metrics.js";
import { deleteExpiredSessions } from "./services/auth.js";
import { deleteExpiredEvents } from "./services/events.js";
import { closeStaleIncidents, deleteExpiredIncidents, dispatchPendingAlerts } from "./services/incidents.js";
import { channelsFromConfig, type AlertChannel } from "./services/alerts.js";
import { listChannels, projectChannels, toAlertChannel } from "./services/channels.js";
import { listProjects } from "./services/projects.js";
import { deleteExpiredSecurityData, deliverSelfAlerts, runDetection } from "./services/security.js";

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
    const security = deleteExpiredSecurityData(db, config.securityRetentionDays);
    metrics.retentionDeleted += deleted;
    metrics.retentionLastRun = new Date().toISOString();
    metrics.retentionLastError = null;
    if (deleted || deletedIncidents || sessions || resolvedIncidents || security.signals || security.findings) {
      log.info("housekeeping", {
        deletedEvents: deleted,
        deletedIncidents,
        deletedSessions: sessions,
        resolvedIncidents,
        deletedSecuritySignals: security.signals,
        deletedSecurityFindings: security.findings,
      });
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

/**
 * Where findings about Super-Logs itself go: they belong to no project, so to
 * every channel anyone configured, each distinct Telegram chat once.
 */
export function selfAlertChannels(db: Db, config: Config): AlertChannel[] {
  const channels = channelsFromConfig(config);
  const seen = new Set(config.telegram ? [`${config.telegram.botToken}|${config.telegram.chatId}|${config.telegram.threadId ?? ""}`] : []);
  for (const project of listProjects(db)) {
    for (const channel of listChannels(db, project.id)) {
      const key = `${channel.settings.botToken}|${channel.settings.chatId}|${channel.settings.threadId ?? ""}`;
      if (!channel.enabled || seen.has(key)) continue;
      seen.add(key);
      channels.push(toAlertChannel(db, channel, config));
    }
  }
  return channels;
}

let securityRunning = false;

/** One detection pass, then delivery of anything it made due. Findings in app projects ride the incident alerts. */
export async function runSecurity(db: Db, config: Config, resolve = channelResolver(db, config)): Promise<void> {
  if (securityRunning) return;
  securityRunning = true;
  try {
    const result = runDetection(db, { alertCooldownMs: config.alertCooldownMs });
    metrics.securityFindingsOpened += result.opened;
    if (result.opened || result.resolved) log.info("security findings", { ...result });
    const self = await deliverSelfAlerts(db, selfAlertChannels(db, config), { alertCooldownMs: config.alertCooldownMs });
    metrics.alertsSent += self.sent;
    metrics.alertsFailed += self.failed;
    if (result.appAlerts) await deliverAlerts(db, resolve);
  } catch (error) {
    log.error("security detection failed", { error });
  } finally {
    securityRunning = false;
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
  const security = setInterval(() => void runSecurity(db, config, resolve), 60_000);
  first.unref();
  timer.unref();
  alerts.unref();
  security.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    clearInterval(alerts);
    clearInterval(security);
  };
}
