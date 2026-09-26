/**
 * Security posture: a short checklist of how this instance is set up,
 * computed on request from the configuration, the database and what the
 * server has observed since it started. Nothing here is stored.
 */
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { proxyObservation } from "../lib/metrics.js";
import { channelsFromConfig } from "./alerts.js";

export interface PostureCheck {
  id: string;
  status: "ok" | "warn" | "info";
  title: string;
  detail?: string;
}

const DAY = 86_400_000;

export function postureChecks(db: Db, config: Config, now = Date.now()): PostureCheck[] {
  const checks: PostureCheck[] = [];
  const count = (sql: string, ...params: (string | number)[]) => (db.prepare(sql).get(...params) as { n: number }).n;

  const local = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(config.publicOrigin);
  checks.push(
    config.secureCookies
      ? { id: "https", status: "ok", title: "The dashboard is served over HTTPS" }
      : {
          id: "https",
          status: local ? "info" : "warn",
          title: local ? "The dashboard runs on plain HTTP (fine on localhost)" : "The dashboard runs on plain HTTP",
          detail: local
            ? undefined
            : "Session cookies and passwords cross the network unencrypted. Set SUPER_LOGS_PUBLIC_URL to an https:// address behind a TLS proxy.",
        },
  );

  const bootstrap = count("SELECT COUNT(*) AS n FROM users WHERE must_change_password = 1");
  checks.push(
    bootstrap === 0
      ? { id: "bootstrap-password", status: "ok", title: "No account still uses its first-boot password" }
      : {
          id: "bootstrap-password",
          status: "warn",
          title: `${bootstrap} account${bootstrap === 1 ? " still uses its" : "s still use their"} first-boot password`,
          detail: "Sign in and change it: the first-boot password is usually written down in a compose or .env file.",
        },
  );

  if (config.admin && count("SELECT COUNT(*) AS n FROM users") > 0) {
    checks.push({
      id: "env-admin-password",
      status: "warn",
      title: "SUPER_LOGS_ADMIN_PASSWORD is still set",
      detail: "It is only read on first boot, when no user exists. Remove it from the environment so the secret does not linger in config files.",
    });
  }

  const recent = (at: number | null) => at !== null && now - at < DAY;
  if (recent(proxyObservation.ignoredHeaderAt)) {
    checks.push({
      id: "proxy",
      status: "warn",
      title: "Requests arrive through a proxy, but SUPER_LOGS_TRUST_PROXY is off",
      detail:
        "Every visitor looks like the proxy's address, so one attacker's failed sign-ins lock everyone out and security findings name the proxy. Turn SUPER_LOGS_TRUST_PROXY on if a proxy you control sits in front.",
    });
  } else if (config.trustProxy && recent(proxyObservation.publicSourceAt)) {
    checks.push({
      id: "proxy",
      status: "warn",
      title: "Forwarded client addresses arrive straight from a public address",
      detail: `The last one came from ${proxyObservation.publicSource}. If that is your CDN (e.g. Cloudflare), make sure the server accepts connections only from it. Otherwise anyone can reach it directly, fake their address, and slip past the sign-in limit.`,
    });
  } else if (config.trustProxy) {
    checks.push({
      id: "proxy",
      status: "info",
      title: "Client addresses are read from proxy headers",
      detail: "Only safe while the server is reachable through your proxy alone. Nothing suggests otherwise so far.",
    });
  } else {
    checks.push({ id: "proxy", status: "ok", title: "Client addresses come from the connection itself" });
  }

  const staleKeys = db
    .prepare(
      `SELECT k.name, p.name AS project FROM api_keys k JOIN projects p ON p.id = k.project_id
       WHERE k.revoked_at IS NULL AND (
         (k.last_used_at IS NULL AND k.created_at < ?) OR (k.last_used_at IS NOT NULL AND k.last_used_at < ?)
       ) ORDER BY p.name, k.name LIMIT 20`,
    )
    .all(new Date(now - 7 * DAY).toISOString(), new Date(now - 30 * DAY).toISOString()) as unknown as { name: string; project: string }[];
  checks.push(
    staleKeys.length === 0
      ? { id: "api-keys", status: "ok", title: "Every ingest key is in use" }
      : {
          id: "api-keys",
          status: "warn",
          title: `${staleKeys.length} ingest key${staleKeys.length === 1 ? " is" : "s are"} unused`,
          detail: `Not used in 30 days, or never used: ${staleKeys.map((key) => `${key.project} / ${key.name}`).join(", ")}. Revoke the ones you no longer need.`,
        },
  );

  const hasChannel =
    channelsFromConfig(config).length > 0 || count("SELECT COUNT(*) AS n FROM notification_channels WHERE enabled = 1") > 0;
  checks.push(
    hasChannel
      ? { id: "alerts", status: "ok", title: "Security findings are sent to an alert channel" }
      : {
          id: "alerts",
          status: "warn",
          title: "No alert channel is configured",
          detail: "Findings only appear on this page. Add a Telegram chat under Projects → Settings.",
        },
  );

  const admins = count("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
  const viewers = count("SELECT COUNT(*) AS n FROM users WHERE role = 'viewer'");
  const sessions = count("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?", now);
  checks.push({
    id: "accounts",
    status: "info",
    title: `${admins} administrator${admins === 1 ? "" : "s"}, ${viewers} viewer${viewers === 1 ? "" : "s"}, ${sessions} active session${sessions === 1 ? "" : "s"}`,
  });

  return checks;
}
