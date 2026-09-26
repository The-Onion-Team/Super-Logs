import { Hono } from "hono/tiny";
import * as v from "../lib/validate.js";
import type { AppEnv } from "../app.js";
import { audit } from "../services/audit.js";
import { deleteAllOtherSessions, deleteSessionById, listSessions } from "../services/auth.js";
import { postureChecks } from "../services/posture.js";
import {
  detectionStatus,
  findingSignals,
  getFinding,
  listFindings,
  recentSignIns,
  resolveFinding,
  securityActivity,
  securityCounts,
} from "../services/security.js";
import { csrf, requireAdmin, requireUser } from "./guards.js";

const findingQuerySchema = v.object({
  status: v.withDefault(v.enumOf(["open", "resolved", "all"]), "open"),
  /** A project id, or `self` for Super-Logs' own findings. */
  project: v.optional(v.string({ max: 64 })),
  limit: v.withDefault(v.number({ coerce: true, int: true, min: 1, max: 200 }), 100),
});

/** The Security page's API. Administrators only: it shows client addresses. */
export function securityRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", csrf, requireUser, requireAdmin);

  app.get("/overview", (c) => {
    const { db, config } = c.get("deps");
    return c.json({
      counts: securityCounts(db),
      activity: securityActivity(db),
      posture: postureChecks(db, config),
      retentionDays: config.securityRetentionDays,
      lastDetectionAt: detectionStatus.lastRunAt === null ? null : new Date(detectionStatus.lastRunAt).toISOString(),
    });
  });

  app.get("/findings", (c) => {
    const parsed = findingQuerySchema.safeParse(c.req.query());
    if (!parsed.ok) return c.json({ error: "invalid_query" }, 400);
    return c.json({ findings: listFindings(c.get("deps").db, parsed.value) });
  });

  app.get("/findings/:id", (c) => {
    const { db } = c.get("deps");
    const finding = getFinding(db, c.req.param("id"));
    if (!finding) return c.json({ error: "not_found" }, 404);
    return c.json({ finding, signals: findingSignals(db, finding) });
  });

  app.post("/findings/:id/resolve", (c) => {
    const { db } = c.get("deps");
    const id = c.req.param("id");
    if (!resolveFinding(db, id)) return c.json({ error: "not_found" }, 404);
    const finding = getFinding(db, id);
    audit(db, "security.finding_resolved", {
      userId: c.get("user").id,
      actor: c.get("user").email,
      target: id,
      detail: { rule: finding?.rule, projectId: finding?.projectId },
    });
    return c.json({ finding });
  });

  app.get("/sign-ins", (c) => c.json({ signIns: recentSignIns(c.get("deps").db) }));

  app.get("/sessions", (c) => c.json({ sessions: listSessions(c.get("deps").db, c.get("sessionHash")) }));

  app.post("/sessions/revoke-others", (c) => {
    const { db } = c.get("deps");
    const revoked = deleteAllOtherSessions(db, c.get("sessionHash"));
    audit(db, "security.sessions_revoked", { userId: c.get("user").id, actor: c.get("user").email, detail: { revoked } });
    return c.json({ revoked });
  });

  app.delete("/sessions/:id", (c) => {
    const { db } = c.get("deps");
    const id = c.req.param("id");
    if (c.get("sessionHash").startsWith(id)) return c.json({ error: "current_session", message: "Use Sign out for this session." }, 400);
    if (!deleteSessionById(db, id)) return c.json({ error: "not_found" }, 404);
    audit(db, "security.session_revoked", { userId: c.get("user").id, actor: c.get("user").email, target: id });
    return c.json({ ok: true });
  });

  return app;
}
