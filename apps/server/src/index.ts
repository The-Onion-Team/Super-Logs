/**
 * Super-Logs server entry point: one process serves ingestion, the dashboard
 * API and the dashboard itself, and runs the housekeeping jobs.
 */
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createApp, createDeps } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { log, setLogLevel } from "./lib/log.js";
import { startHousekeeping } from "./jobs.js";
import { ensureAdmin, countUsers } from "./services/auth.js";

const config = loadConfig();
setLogLevel(config.logLevel);

if (!config.dashboardDir) {
  // In the monorepo the dashboard builds next door.
  const sibling = fileURLToPath(new URL("../../dashboard/dist", import.meta.url));
  if (existsSync(sibling)) config.dashboardDir = sibling;
  else log.warning("dashboard not built; serving the API only (run npm run build)");
}

const db = openDatabase(config.databaseFile);
const admin = await ensureAdmin(db, config.admin);
if (admin) log.info("administrator created; the password must be changed at first sign-in", { email: admin.email });
else if (countUsers(db) === 0) {
  log.warning("no users exist: set SUPER_LOGS_ADMIN_EMAIL and SUPER_LOGS_ADMIN_PASSWORD and restart");
}

const deps = createDeps(db, config, (c) => {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
});
const app = createApp(deps);
const stopHousekeeping = startHousekeeping(db, config);

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  log.info("super-logs listening", { host: info.address, port: info.port, publicOrigin: config.publicOrigin, dataDir: config.dataDir });
});

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    stopHousekeeping();
    server.close(() => {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        db.close();
      } finally {
        process.exit(0);
      }
    });
    // Do not hang on keep-alive connections.
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
