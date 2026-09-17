import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { log } from "./lib/log.js";
import { metrics } from "./lib/metrics.js";
import { deleteExpiredSessions } from "./services/auth.js";
import { deleteExpiredEvents } from "./services/events.js";

/** Retention and cleanup, so the database cannot grow without bound (IDEA §18). */
export function runHousekeeping(db: Db, config: Config): void {
  try {
    const deleted = deleteExpiredEvents(db, config.retentionDays);
    const sessions = deleteExpiredSessions(db);
    metrics.retentionDeleted += deleted;
    metrics.retentionLastRun = new Date().toISOString();
    metrics.retentionLastError = null;
    if (deleted || sessions) log.info("housekeeping", { deletedEvents: deleted, deletedSessions: sessions });
    // Keep the WAL from growing between automatic checkpoints, and let SQLite refresh its statistics.
    db.exec("PRAGMA wal_checkpoint(PASSIVE); PRAGMA optimize;");
  } catch (error) {
    metrics.retentionLastError = error instanceof Error ? error.message : String(error);
    log.error("housekeeping failed", { error });
  }
}

export function startHousekeeping(db: Db, config: Config): () => void {
  const first = setTimeout(() => runHousekeeping(db, config), 30_000);
  const timer = setInterval(() => runHousekeeping(db, config), 60 * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
