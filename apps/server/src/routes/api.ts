import { statSync } from "node:fs";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.js";
import { metrics } from "../lib/metrics.js";
import { audit, listAudit } from "../services/audit.js";
import { eventFacets, eventQuerySchema, eventStats, getEvent, queryEvents } from "../services/events.js";
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

const nameSchema = z.object({ name: z.string().trim().min(1).max(80) });

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
    if (!parsed.success) return c.json({ error: "invalid_name" }, 400);
    const project = createProject(db, parsed.data.name);
    audit(db, "project.created", { userId: c.get("user").id, actor: c.get("user").email, target: project.id, detail: { name: project.name } });
    return c.json({ project }, 201);
  });

  app.patch("/projects/:id", requireAdmin, async (c) => {
    const { db } = c.get("deps");
    const parsed = nameSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_name" }, 400);
    if (!renameProject(db, c.req.param("id"), parsed.data.name)) return c.json({ error: "not_found" }, 404);
    audit(db, "project.renamed", { userId: c.get("user").id, actor: c.get("user").email, target: c.req.param("id"), detail: { name: parsed.data.name } });
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
    if (!parsed.success) return c.json({ error: "invalid_name" }, 400);
    const { key, secret } = createKey(db, projectId, parsed.data.name);
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

  // --- events --------------------------------------------------------------

  app.get("/projects/:id/events", (c) => {
    const { db } = c.get("deps");
    const projectId = c.req.param("id");
    if (!getProject(db, projectId)) return c.json({ error: "not_found" }, 404);
    const parsed = eventQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return c.json({ error: "invalid_query", message: issue ? `${issue.path.join(".")}: ${issue.message}` : undefined }, 400);
    }
    return c.json(queryEvents(db, projectId, parsed.data));
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
    return c.json(eventStats(db, c.req.param("id"), hours));
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
