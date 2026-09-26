/**
 * Every setting comes from the environment (see `.env.example`). Parsed once
 * at boot; a bad value stops the server with a readable message instead of
 * failing later.
 */
import { resolve } from "node:path";
import * as v from "./lib/validate.js";

const bool = v.map(v.enumOf(["1", "0", "true", "false", "yes", "no"]), (value) => ["1", "true", "yes"].includes(value));

const schema = v.refine(
  v.object({
    SUPER_LOGS_HOST: v.withDefault(v.string(), "0.0.0.0"),
    SUPER_LOGS_PORT: v.withDefault(v.number({ coerce: true, int: true, min: 1, max: 65535 }), 3000),
    /** The URL people open the dashboard at. Decides cookie `Secure` and the allowed Origin. */
    SUPER_LOGS_PUBLIC_URL: v.withDefault(v.url(), "http://localhost:3000"),
    SUPER_LOGS_DATA_DIR: v.withDefault(v.string(), "./data"),
    SUPER_LOGS_DASHBOARD_DIR: v.optional(v.string()),
    /** First-boot administrator. Ignored once any user exists. */
    SUPER_LOGS_ADMIN_EMAIL: v.optional(v.email()),
    SUPER_LOGS_ADMIN_PASSWORD: v.optional(v.string({ min: 12 })),
    SUPER_LOGS_SESSION_TTL_HOURS: v.withDefault(v.number({ coerce: true, int: true, min: 1, max: 24 * 90 }), 24 * 7),
    /** Raw events older than this are deleted. */
    SUPER_LOGS_RETENTION_DAYS: v.withDefault(v.number({ coerce: true, int: true, min: 1, max: 3650 }), 14),
    /** Security signals (the only data holding client IPs) and resolved findings older than this are deleted. */
    SUPER_LOGS_SECURITY_RETENTION_DAYS: v.withDefault(v.number({ coerce: true, int: true, min: 1, max: 365 }), 7),
    /** Per ingest key. */
    SUPER_LOGS_INGEST_EVENTS_PER_MINUTE: v.withDefault(v.number({ coerce: true, int: true, min: 1 }), 6000),
    /** Read the client IP from Cloudflare / reverse-proxy headers. Only enable behind a proxy you control. */
    SUPER_LOGS_TRUST_PROXY: v.withDefault(bool, true),
    /** Optional JSON webhook for incident alerts. Unset keeps alerts local. */
    SUPER_LOGS_ALERT_WEBHOOK_URL: v.optional(v.url()),
    /** Minimum time between repeated alerts for one ongoing incident. */
    SUPER_LOGS_ALERT_COOLDOWN_MINUTES: v.withDefault(v.number({ coerce: true, int: true, min: 1, max: 24 * 60 }), 15),
    SUPER_LOGS_LOG_LEVEL: v.withDefault(v.enumOf(["debug", "info", "warning", "error"]), "info"),
    /** Telegram alerts. Both the token and the chat id are needed, or neither. */
    SUPER_LOGS_TELEGRAM_BOT_TOKEN: v.optional(
      v.string({ pattern: /^\d+:[\w-]{30,}$/, patternMessage: "must look like 123456789:AA... (from @BotFather)" }),
    ),
    /** A numeric chat id (often negative for groups) or an @channelusername. */
    SUPER_LOGS_TELEGRAM_CHAT_ID: v.optional(v.string({ trim: true, min: 1, max: 100 })),
    /** Incidents below this level are not sent to Telegram. */
    SUPER_LOGS_TELEGRAM_MIN_LEVEL: v.withDefault(v.enumOf(["warning", "error", "critical"]), "warning"),
    /** Topic id, for forum-style supergroups. */
    SUPER_LOGS_TELEGRAM_THREAD_ID: v.optional(v.number({ coerce: true, int: true, min: 1 })),
    /** Point at a mirror or proxy where api.telegram.org is blocked or slow. */
    SUPER_LOGS_TELEGRAM_API_BASE_URL: v.withDefault(v.url(), "https://api.telegram.org"),
  }),
  (e) => Boolean(e.SUPER_LOGS_TELEGRAM_BOT_TOKEN) === Boolean(e.SUPER_LOGS_TELEGRAM_CHAT_ID),
  {
    path: "SUPER_LOGS_TELEGRAM_CHAT_ID",
    message: "set SUPER_LOGS_TELEGRAM_BOT_TOKEN and SUPER_LOGS_TELEGRAM_CHAT_ID together, or neither",
  },
);

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.ok) {
    const problems = parsed.issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join("\n");
    throw new Error(`Invalid Super-Logs configuration:\n${problems}`);
  }
  const e = parsed.value;
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
    securityRetentionDays: e.SUPER_LOGS_SECURITY_RETENTION_DAYS,
    ingestEventsPerMinute: e.SUPER_LOGS_INGEST_EVENTS_PER_MINUTE,
    trustProxy: e.SUPER_LOGS_TRUST_PROXY,
    alertWebhookUrl: e.SUPER_LOGS_ALERT_WEBHOOK_URL,
    alertCooldownMs: e.SUPER_LOGS_ALERT_COOLDOWN_MINUTES * 60_000,
    /** Where the Bot API lives, for every Telegram channel however it was configured. */
    telegramApiBaseUrl: e.SUPER_LOGS_TELEGRAM_API_BASE_URL,
    /** The environment-configured Telegram channel, which alerts for every project. */
    telegram:
      e.SUPER_LOGS_TELEGRAM_BOT_TOKEN && e.SUPER_LOGS_TELEGRAM_CHAT_ID
        ? {
            botToken: e.SUPER_LOGS_TELEGRAM_BOT_TOKEN,
            chatId: e.SUPER_LOGS_TELEGRAM_CHAT_ID,
            minLevel: e.SUPER_LOGS_TELEGRAM_MIN_LEVEL,
            threadId: e.SUPER_LOGS_TELEGRAM_THREAD_ID,
            apiBaseUrl: e.SUPER_LOGS_TELEGRAM_API_BASE_URL,
          }
        : undefined,
    logLevel: e.SUPER_LOGS_LOG_LEVEL,
  };
}
