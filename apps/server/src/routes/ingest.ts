import { LIMITS, type IngestResult } from "@super-logs/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../app.js";
import { log } from "../lib/log.js";
import { metrics } from "../lib/metrics.js";
import { batchSchema, insertEvents, normalizeEvent } from "../services/events.js";

/**
 * `POST /api/ingest` — server-to-server event intake.
 *
 * Auth: `Authorization: Bearer slk_…` (or `X-Super-Logs-Key`). Events are
 * validated one by one, so a single bad event does not reject its batch.
 */
export function ingestRoutes() {
  const app = new Hono<AppEnv>();

  app.post(
    "/",
    bodyLimit({
      maxSize: LIMITS.maxBatchBytes,
      onError: (c) => c.json({ error: "payload_too_large", maxBytes: LIMITS.maxBatchBytes }, 413),
    }),
    async (c) => {
      const { db, keys, limits } = c.get("deps");
      metrics.ingestRequests++;

      const header = c.req.header("authorization");
      const secret = header?.startsWith("Bearer ") ? header.slice(7).trim() : c.req.header("x-super-logs-key");
      const key = secret ? keys.resolve(secret) : null;
      if (!key) {
        metrics.ingestUnauthorized++;
        return c.json({ error: "invalid_api_key" }, 401);
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid_json" }, 400);
      }
      const batch = batchSchema.safeParse(body);
      if (!batch.success) {
        return c.json({ error: "invalid_batch", message: `Expected { events: [...] } with 1–${LIMITS.maxEventsPerBatch} events` }, 400);
      }

      const granted = limits.ingest.take(key.keyId, batch.data.events.length);
      if (granted === 0) {
        metrics.ingestRateLimited++;
        c.header("retry-after", "10");
        return c.json({ error: "rate_limited" }, 429);
      }

      const receivedAt = Date.now();
      const accepted: Parameters<typeof insertEvents>[2] = [];
      const errors: NonNullable<IngestResult["errors"]> = [];
      batch.data.events.forEach((raw, index) => {
        if (index >= granted) {
          errors.push({ index, message: "rate limited" });
          return;
        }
        const result = normalizeEvent(raw, receivedAt);
        if (result.ok) accepted.push({ event: result.event, ts: result.ts });
        else if (errors.length < 20) errors.push({ index, message: result.message });
      });

      const started = performance.now();
      try {
        insertEvents(db, key.projectId, accepted, receivedAt, c.get("deps").config.alertCooldownMs);
        keys.touch(key.keyId, receivedAt);
      } catch (error) {
        metrics.ingestErrors++;
        log.error("ingest write failed", { error, projectId: key.projectId, events: accepted.length });
        return c.json({ error: "storage_unavailable" }, 503);
      }
      metrics.lastIngestMs = Math.round(performance.now() - started);

      const rejected = batch.data.events.length - accepted.length;
      metrics.eventsAccepted += accepted.length;
      metrics.eventsRejected += rejected;
      const result: IngestResult = { accepted: accepted.length, rejected, ...(errors.length ? { errors } : {}) };
      return c.json(result, 202);
    },
  );

  return app;
}
