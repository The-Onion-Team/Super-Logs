import { statSync } from "node:fs";
import { Hono } from "hono/tiny";
import * as v from "../lib/validate.js";
import type { AppEnv } from "../app.js";
import { metrics } from "../lib/metrics.js";
import { audit, listAudit } from "../services/audit.js";
import { eventFacets, eventQuerySchema, eventStats, getEvent, queryEvents } from "../services/events.js";
import { closeStaleIncidents, getIncident, listIncidents, resolveIncident } from "../services/incidents.js";
import { TELEGRAM_API, discoverChats } from "../services/telegram.js";
import {
  deleteChannel,
  getChannel,
  listChannels,
  saveChannel,
  toAlertChannel,
  toSummary,
  type ChannelKind,
} from "../services/channels.js";
import {
  createKey,
  createProject,
  deleteProject,
  getProject,
  listKeys,
  listProjects,
  renameProject,
  revokeKey,
} from "../services/projects.js";
import { csrf, requireAdmin, requireUser } from "./guards.js";

const nameSchema = v.object({ name: v.string({ trim: true, min: 1, max: 80 }) });

/**
 * A Telegram channel as the dashboard submits it. The token is optional on
 * update so the chat can be changed without retyping it; an empty string means
 * the same thing, because that is what an untouched password field sends.
 */
const telegramChannelSchema = v.object({
  enabled: v.withDefault(v.boolean(), true),
  minLevel: v.withDefault(v.enumOf(["warning", "error", "critical"]), "warning"),
  botToken: v.optional(
    v.string({ trim: true, pattern: /^\d+:[\w-]{30,}$/, patternMessage: "must look like 123456789:AA… (from @BotFather)" }),
  ),
  chatId: v.string({ trim: true, min: 1, max: 100, pattern: /^(-?\d+|@[\w]{5,})$/, patternMessage: "must be a numeric chat id or @channelusername" }),
  threadId: v.optional(v.number({ coerce: true, int: true, min: 1 })),
});

const discoverSchema = v.object({
  botToken: v.optional(
    v.string({ trim: true, pattern: /^\d+:[\w-]{30,}$/, patternMessage: "must look like 123456789:AA… (from @BotFather)" }),
  ),
});
const incidentQuerySchema = v.object({
  status: v.withDefault(v.enumOf(["open", "resolved", "all"]), "open"),
  limit: v.withDefault(v.number({ coerce: true, int: true, min: 1, max: 100 }), 20),
});

/**
 * The stats payload aggregates over the whole window, and `node:sqlite` is
 * synchronous — so an uncached one would block ingest on every live-tail poll.
 * A short TTL keeps the dashboard usefully fresh and the writer unblocked.
 */
const STATS_TTL_MS = 15_000;
const statsCache = new Map<string, { at: number; value: unknown }>();

function cachedStats(db: Parameters<typeof eventStats>[0], projectId: string, hours: number): unknown {
  const key = `${projectId}:${hours}`;
  const hit = statsCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < STATS_TTL_MS) return hit.value;
  const value = eventStats(db, projectId, hours);
  statsCache.set(key, { at: now, value });
  // Projects come and go; the cache must not pin them forever.
  if (statsCache.size > 64) {
    for (const [k, entry] of statsCache) if (now - entry.at >= STATS_TTL_MS) statsCache.delete(k);
  }
  return value;
}

/** Dashboard API. Cookie-authenticated; every write is CSRF-checked. */
export function apiRoutes() {
  const app = new Hono<AppEnv>();
  app.use("/projects/*", csrf, requireUser);
  app.use("/projects", csrf, requireUser);
  app.use("/audit", requireUser, requireAdmin);
  app.use("/system", requireUser);

  // --- projects & keys -----------------------------------------------------

  app.get("/projects", (c) => c.json({ projects: listProjects(c.get("deps").db) }));

  app.post("/projects", requireAdmin, async (c) => {
    const { db } = c.get("deps");
    const parsed = nameSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: "invalid_name" }, 400);
    const project = createProject(db, parsed.value.name);
    audit(db, "project.created", { userId: c.get("user").id, actor: c.get("user").email, target: project.id, detail: { name: project.name } });
    return c.json({ project }, 201);
  });

  app.patch("/projects/:id", requireAdmin, async (c) => {
    const { db } = c.get("deps");
    const parsed = nameSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: "invalid_name" }, 400);
    if (!renameProject(db, c.req.param("id"), parsed.value.name)) return c.json({ error: "not_found" }, 404);
    audit(db, "project.renamed", { userId: c.get("user").id, actor: c.get("user").email, target: c.req.param("id"), detail: { name: parsed.value.name } });
    return c.json({ project: getProject(db, c.req.param("id")) });
  });

  app.delete("/projects/:id", requireAdmin, async (c) => {
    const { db, keys } = c.get("deps");
    const project = getProject(db, c.req.param("id"));
    if (!project) return c.json({ error: "not_found" }, 404);
    // Deleting all of a project's data is irreversible: the caller must repeat the slug.
    const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
    if (body?.confirm !== project.slug) return c.json({ error: "confirmation_required", expected: "slug" }, 400);
    deleteProject(db, project.id);
    keys.invalidate();
    audit(db, "project.deleted", { userId: c.get("user").id, actor: c.get("user").email, target: project.id, detail: { name: project.name } });
    return c.json({ ok: true });
  });

  app.get("/projects/:id/keys", requireAdmin, (c) => {
    const { db } = c.get("deps");
    if (!getProject(db, c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    return c.json({ keys: listKeys(db, c.req.param("id")) });
  });

  app.post("/projects/:id/keys", requireAdmin, async (c) => {
    const { db } = c.get("deps");
    const projectId = c.req.param("id");
    if (!getProject(db, projectId)) return c.json({ error: "not_found" }, 404);
    const parsed = nameSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: "invalid_name" }, 400);
    const { key, secret } = createKey(db, projectId, parsed.value.name);
    audit(db, "api_key.created", { userId: c.get("user").id, actor: c.get("user").email, target: key.id, detail: { projectId, name: key.name, prefix: key.prefix } });
    return c.json({ key, secret }, 201);
  });

  app.delete("/projects/:id/keys/:keyId", requireAdmin, (c) => {
    const { db, keys } = c.get("deps");
    if (!revokeKey(db, c.req.param("id"), c.req.param("keyId"))) return c.json({ error: "not_found" }, 404);
    keys.invalidate();
    audit(db, "api_key.revoked", { userId: c.get("user").id, actor: c.get("user").email, target: c.req.param("keyId"), detail: { projectId: c.req.param("id") } });
    return c.json({ ok: true });
  });

  // --- notification channels ----------------------------------------------

  app.get("/projects/:id/notifications", requireAdmin, (c) => {
    const { db, config } = c.get("deps");
    const projectId = c.req.param("id");
    if (!getProject(db, projectId)) return c.json({ error: "not_found" }, 404);
    return c.json({
      channels: listChannels(db, projectId).map(toSummary),
      // Surfaced so a mirror, proxy or test double cannot masquerade as
      // Telegram: without this, a "message sent" from somewhere that always
      // answers ok looks exactly like a real delivery.
      telegramApiBaseUrl: config.telegramApiBaseUrl === TELEGRAM_API ? null : config.telegramApiBaseUrl,
    });
  });

  app.put("/projects/:id/notifications/telegram", requireAdmin, async (c) => {
    const { db } = c.get("deps");
    const projectId = c.req.param("id");
    if (!getProject(db, projectId)) return c.json({ error: "not_found" }, 404);

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    // An untouched password field posts "", which means "keep what is stored".
    if (body && body.botToken === "") delete body.botToken;
    const parsed = telegramChannelSchema.safeParse(body);
    if (!parsed.ok) {
      const issue = parsed.issues[0];
      return c.json({ error: "invalid_channel", field: issue?.path, message: issue?.message }, 400);
    }

    const saved = saveChannel(db, projectId, "telegram", parsed.value);
    if (!saved) return c.json({ error: "bot_token_required", message: "Add the bot token from @BotFather to set this up." }, 400);
    audit(db, "notification_channel.saved", {
      userId: c.get("user").id,
      actor: c.get("user").email,
      target: saved.id,
      // The token is never written to the audit log, only which chat it points at.
      detail: { projectId, kind: "telegram", chatId: saved.settings.chatId, enabled: saved.enabled, minLevel: saved.minLevel },
    });
    return c.json({ channel: toSummary(saved) });
  });

  app.delete("/projects/:id/notifications/:kind", requireAdmin, (c) => {
    const { db } = c.get("deps");
    const projectId = c.req.param("id");
    const kind = c.req.param("kind") as ChannelKind;
    if (!deleteChannel(db, projectId, kind)) return c.json({ error: "not_found" }, 404);
    audit(db, "notification_channel.deleted", {
      userId: c.get("user").id,
      actor: c.get("user").email,
      detail: { projectId, kind },
    });
    return c.json({ ok: true });
  });

  /**
   * Looks up which chats a bot can post to. This is the step that otherwise
   * means reading raw `getUpdates` JSON by hand, so the dashboard offers the
   * answer as buttons instead. Nothing is stored: the token is only borrowed
   * for the lookup, and a typo never reaches the database.
   */
  app.post("/projects/:id/notifications/telegram/discover", requireAdmin, async (c) => {
    const { db, config } = c.get("deps");
    const projectId = c.req.param("id");
    if (!getProject(db, projectId)) return c.json({ error: "not_found" }, 404);

    const body = (await c.req.json().catch(() => null)) as { botToken?: unknown } | null;
    const supplied = discoverSchema.safeParse(body ?? {});
    if (!supplied.ok) {
      const issue = supplied.issues[0];
      return c.json({ error: "invalid_channel", message: issue?.message }, 400);
    }
    // Fall back to the stored token, so "Find my chats" works on a saved
    // channel without the operator digging the token out again.
    const botToken = supplied.value.botToken ?? getChannel(db, projectId, "telegram")?.settings.botToken;
    if (!botToken) return c.json({ error: "bot_token_required" }, 400);

    const result = await discoverChats(botToken, config.telegramApiBaseUrl);
    if (!result.ok) return c.json({ error: "discover_failed", message: result.message }, 502);
    return c.json({ botUsername: result.botUsername, chats: result.chats });
  });

  /** Sends a real message through the stored settings, so setup can be proven before an incident. */
  app.post("/projects/:id/notifications/:kind/test", requireAdmin, async (c) => {
    const { db, config } = c.get("deps");
    const projectId = c.req.param("id");
    const project = getProject(db, projectId);
    if (!project) return c.json({ error: "not_found" }, 404);
    const channel = getChannel(db, projectId, c.req.param("kind") as ChannelKind);
    if (!channel) return c.json({ error: "not_found" }, 404);

    const now = new Date().toISOString();
    try {
      await toAlertChannel(db, channel, config).send({
        alertId: 0,
        id: "inc_test",
        projectId,
        projectName: project.name,
        fingerprint: "testtesttesttest",
        status: "open",
        level: channel.minLevel,
        eventCount: 1,
        firstSeen: now,
        lastSeen: now,
        title: "Test alert from Super-Logs",
        message: "If you can read this, incident alerts for this project will arrive here.",
        service: null,
        route: null,
      });
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: "send_failed", message: error instanceof Error ? error.message : String(error) }, 502);
    }
  });

  // --- events --------------------------------------------------------------

  app.get("/projects/:id/events", (c) => {
    const { db } = c.get("deps");
    const projectId = c.req.param("id");
    if (!getProject(db, projectId)) return c.json({ error: "not_found" }, 404);
    const parsed = eventQuerySchema.safeParse(c.req.query());
    if (!parsed.ok) {
      const issue = parsed.issues[0];
      return c.json({ error: "invalid_query", message: issue ? `${issue.path}: ${issue.message}` : undefined }, 400);
    }
    return c.json(queryEvents(db, projectId, parsed.value));
  });

  app.get("/projects/:id/events/:eventId{[0-9]+}", (c) => {
    const { db } = c.get("deps");
    const event = getEvent(db, c.req.param("id"), Number(c.req.param("eventId")));
    return event ? c.json({ event }) : c.json({ error: "not_found" }, 404);
  });

  app.get("/projects/:id/facets", (c) => {
    const { db } = c.get("deps");
    if (!getProject(db, c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    return c.json(eventFacets(db, c.req.param("id")));
  });

  app.get("/projects/:id/stats", (c) => {
    const { db } = c.get("deps");
    if (!getProject(db, c.req.param("id"))) return c.json({ error: "not_found" }, 404);
    const hours = Math.min(168, Math.max(1, Number(c.req.query("hours") ?? 24) || 24));
    return c.json(cachedStats(db, c.req.param("id"), hours));
  });

  // --- incidents -----------------------------------------------------------

  app.get("/projects/:id/incidents", (c) => {
    const { db } = c.get("deps");
    const projectId = c.req.param("id");
    if (!getProject(db, projectId)) return c.json({ error: "not_found" }, 404);
    const parsed = incidentQuerySchema.safeParse(c.req.query());
    if (!parsed.ok) return c.json({ error: "invalid_query" }, 400);
    closeStaleIncidents(db);
    return c.json({ incidents: listIncidents(db, projectId, parsed.value) });
  });

  app.get("/projects/:id/incidents/:incidentId", (c) => {
    const { db } = c.get("deps");
    closeStaleIncidents(db);
    const incident = getIncident(db, c.req.param("id"), c.req.param("incidentId"));
    return incident ? c.json({ incident }) : c.json({ error: "not_found" }, 404);
  });

  app.post("/projects/:id/incidents/:incidentId/resolve", (c) => {
    const { db } = c.get("deps");
    const projectId = c.req.param("id");
    if (!resolveIncident(db, projectId, c.req.param("incidentId"))) return c.json({ error: "not_found" }, 404);
    audit(db, "incident.resolved", {
      userId: c.get("user").id,
      actor: c.get("user").email,
      target: c.req.param("incidentId"),
      detail: { projectId },
    });
    return c.json({ incident: getIncident(db, projectId, c.req.param("incidentId")) });
  });

  // --- administration ------------------------------------------------------

  app.get("/audit", (c) => {
    const before = Number(c.req.query("before"));
    return c.json({ entries: listAudit(c.get("deps").db, 200, Number.isFinite(before) && before > 0 ? before : undefined) });
  });

  app.get("/system", (c) => {
    const { config, db } = c.get("deps");
    const size = (file: string) => {
      try {
        return statSync(file).size;
      } catch {
        return 0;
      }
    };
    const events = (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    return c.json({
      version: process.env.SUPER_LOGS_VERSION ?? "dev",
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1_048_576),
      database: {
        bytes: size(config.databaseFile) + size(`${config.databaseFile}-wal`),
        events,
      },
      retentionDays: config.retentionDays,
      counters: metrics,
    });
  });

  return app;
}
