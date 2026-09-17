/**
 * Every setting comes from the environment (see `.env.example`). Parsed once
 * at boot; a bad value stops the server with a readable message instead of
 * failing later.
 */
import { resolve } from "node:path";
import { z } from "zod";

const bool = z
  .enum(["1", "0", "true", "false", "yes", "no"])
  .transform((value) => ["1", "true", "yes"].includes(value));

const schema = z.object({
  SUPER_LOGS_HOST: z.string().default("0.0.0.0"),
  SUPER_LOGS_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** The URL people open the dashboard at. Decides cookie `Secure` and the allowed Origin. */
  SUPER_LOGS_PUBLIC_URL: z.url().default("http://localhost:3000"),
  SUPER_LOGS_DATA_DIR: z.string().default("./data"),
  SUPER_LOGS_DASHBOARD_DIR: z.string().optional(),
  /** First-boot administrator. Ignored once any user exists. */
  SUPER_LOGS_ADMIN_EMAIL: z.email().optional(),
  SUPER_LOGS_ADMIN_PASSWORD: z.string().min(12, "SUPER_LOGS_ADMIN_PASSWORD must be at least 12 characters").optional(),
  SUPER_LOGS_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 7),
  /** Raw events older than this are deleted. */
  SUPER_LOGS_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(14),
  /** Per ingest key. */
  SUPER_LOGS_INGEST_EVENTS_PER_MINUTE: z.coerce.number().int().min(1).default(6000),
  /** Read the client IP from Cloudflare / reverse-proxy headers. Only enable behind a proxy you control. */
  SUPER_LOGS_TRUST_PROXY: bool.default(true),
  SUPER_LOGS_LOG_LEVEL: z.enum(["debug", "info", "warning", "error"]).default("info"),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid Super-Logs configuration:\n${problems}`);
  }
  const e = parsed.data;
  const publicUrl = new URL(e.SUPER_LOGS_PUBLIC_URL);
  const dataDir = resolve(e.SUPER_LOGS_DATA_DIR);
  return {
    host: e.SUPER_LOGS_HOST,
    port: e.SUPER_LOGS_PORT,
    publicOrigin: publicUrl.origin,
    secureCookies: publicUrl.protocol === "https:",
    dataDir,
    databaseFile: resolve(dataDir, "super-logs.db"),
    dashboardDir: e.SUPER_LOGS_DASHBOARD_DIR ? resolve(e.SUPER_LOGS_DASHBOARD_DIR) : undefined,
    admin:
      e.SUPER_LOGS_ADMIN_EMAIL && e.SUPER_LOGS_ADMIN_PASSWORD
        ? { email: e.SUPER_LOGS_ADMIN_EMAIL, password: e.SUPER_LOGS_ADMIN_PASSWORD }
        : undefined,
    sessionTtlMs: e.SUPER_LOGS_SESSION_TTL_HOURS * 3_600_000,
    retentionDays: e.SUPER_LOGS_RETENTION_DAYS,
    ingestEventsPerMinute: e.SUPER_LOGS_INGEST_EVENTS_PER_MINUTE,
    trustProxy: e.SUPER_LOGS_TRUST_PROXY,
    logLevel: e.SUPER_LOGS_LOG_LEVEL,
  };
}
