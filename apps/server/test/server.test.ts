import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createDeps, type AppDeps } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { ensureAdmin } from "../src/services/auth.js";
import { createKey, createProject } from "../src/services/projects.js";
import { deleteExpiredEvents, ftsQuery } from "../src/services/events.js";
import { dispatchPendingAlerts } from "../src/services/incidents.js";

const ORIGIN = "https://logs.example.com";
const ADMIN = { email: "admin@example.com", password: "correct horse battery" };

let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let projectId: string;
let apiKey: string;

beforeEach(async () => {
  const config = loadConfig({
    SUPER_LOGS_PUBLIC_URL: ORIGIN,
    SUPER_LOGS_DATA_DIR: "/tmp/unused",
    SUPER_LOGS_LOG_LEVEL: "error",
    SUPER_LOGS_INGEST_EVENTS_PER_MINUTE: "50",
  });
  const db = openDatabase(":memory:");
  await ensureAdmin(db, ADMIN);
  deps = createDeps(db, config);
  app = createApp(deps);
  projectId = createProject(db, "FantaF1").id;
  apiKey = createKey(db, projectId, "backend").secret;
});

/** Test responses are JSON of known shape. */
const read = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const ingest = (body: unknown, key = apiKey) =>
  app.request("/api/ingest", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** A tiny cookie-carrying client for the dashboard API. */
function browser() {
  let cookie = "";
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await app.request(path, {
      ...init,
      headers: {
        origin: ORIGIN,
        "x-super-logs-csrf": "1",
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(init.headers as Record<string, string>),
      },
    });
    const set = response.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
    return response;
  };
  return {
    call,
    get: (path: string) => call(path),
    post: (path: string, body?: unknown) => call(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
    signIn(password = ADMIN.password) {
      return call("/api/auth/login", { method: "POST", body: JSON.stringify({ email: ADMIN.email, password }) });
    },
    async signInReady() {
      await this.signIn();
      const changed = await this.post("/api/auth/password", { currentPassword: ADMIN.password, newPassword: "a brand new passphrase" });
      expect(changed.status).toBe(200);
    },
  };
}

describe("ingest", () => {
  it("rejects missing and unknown keys", async () => {
    expect((await ingest({ events: [] }, "")).status).toBe(401);
    expect((await ingest({ events: [] }, "slk_" + "x".repeat(32))).status).toBe(401);
  });

  it("accepts valid events, rejects invalid ones individually, and redacts", async () => {
    const response = await ingest({
      events: [
        {
          level: "error",
          message: "Failed to load standings",
          service: "frontend",
          requestId: "req_12345678",
          route: "/standings?league=1",
          httpStatus: 500,
          error: { name: "ApiError", message: "boom", stack: "ApiError: boom\n    at load (app.js:1:1)" },
          metadata: { endpoint: "/api/standings", password: "hunter2" },
          tags: { league: "main" },
        },
        { level: "loud", message: "bad level" },
        { level: "info", message: "" },
      ],
    });
    expect(response.status).toBe(202);
    const body = await read(response);
    expect(body).toMatchObject({ accepted: 1, rejected: 2 });
    expect(body.errors).toHaveLength(2);

    const row = deps.db.prepare("SELECT * FROM events").get() as Record<string, unknown>;
    expect(row).toMatchObject({ level: 40, route: "/standings", request_id: "req_12345678", http_status: 500 });
    expect(row.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.parse(String(row.metadata))).toEqual({ endpoint: "/api/standings", password: "[REDACTED]" });
  });

  it("replaces skewed client timestamps with the receive time", async () => {
    await ingest({ events: [{ level: "info", message: "from the future", timestamp: "2099-01-01T00:00:00Z" }] });
    const row = deps.db.prepare("SELECT ts, metadata FROM events").get() as { ts: number; metadata: string };
    expect(Math.abs(row.ts - Date.now())).toBeLessThan(5_000);
    expect(JSON.parse(row.metadata)._clientTimestamp).toBe("2099-01-01T00:00:00Z");
  });

  it("rejects malformed batches and oversized bodies", async () => {
    expect((await ingest("{nope")).status).toBe(400);
    expect((await ingest({ events: "x" })).status).toBe(400);
    expect((await ingest({ events: Array.from({ length: 101 }, () => ({ level: "info", message: "x" })) })).status).toBe(400);
    expect((await ingest({ events: [{ level: "info", message: "x".repeat(600_000) }] })).status).toBe(413);
  });

  it("rate-limits per key", async () => {
    const events = Array.from({ length: 40 }, () => ({ level: "info", message: "x" }));
    expect((await ingest({ events })).status).toBe(202);
    const partial = await read(ingest({ events }));
    expect(partial.accepted).toBeLessThan(40);
    expect((await ingest({ events })).status).toBe(429);
  });

  it("stops accepting a revoked key", async () => {
    const client = browser();
    await client.signInReady();
    const keys = await read(client.get(`/api/projects/${projectId}/keys`));
    const revoke = await client.call(`/api/projects/${projectId}/keys/${keys.keys[0].id}`, { method: "DELETE" });
    expect(revoke.status).toBe(200);
    expect((await ingest({ events: [{ level: "info", message: "x" }] })).status).toBe(401);
  });
});

describe("dashboard auth", () => {
  it("requires sign-in and a password change for the bootstrap admin", async () => {
    const client = browser();
    expect((await client.get(`/api/projects`)).status).toBe(401);
    expect((await client.signIn("wrong password!!")).status).toBe(401);
    expect((await client.signIn()).status).toBe(200);
    const blocked = await client.get(`/api/projects`);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "password_change_required" });
    const me = await read(client.get("/api/auth/me"));
    expect(me.user).toMatchObject({ email: ADMIN.email, role: "admin", mustChangePassword: true });
    expect(me.user).not.toHaveProperty("password_hash");
  });

  it("sets a hardened session cookie", async () => {
    const response = await browser().signIn();
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/sl_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it("rejects writes without the CSRF header or from another origin", async () => {
    const noHeader = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(ADMIN),
    });
    expect(noHeader.status).toBe(403);
    const client = browser();
    const crossSite = await client.call("/api/auth/login", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify(ADMIN),
    });
    expect(crossSite.status).toBe(403);
  });

  it("locks out repeated failures", async () => {
    const client = browser();
    for (let i = 0; i < 5; i++) expect((await client.signIn(`wrong password ${i}`)).status).toBe(401);
    expect((await client.signIn()).status).toBe(429);
  });

  it("signs out", async () => {
    const client = browser();
    await client.signInReady();
    expect((await client.get("/api/projects")).status).toBe(200);
    expect((await client.post("/api/auth/logout")).status).toBe(200);
    expect((await client.get("/api/projects")).status).toBe(401);
  });
});

describe("dashboard API", () => {
  it("creates projects and keys, and audits it", async () => {
    const client = browser();
    await client.signInReady();
    const created = await client.post("/api/projects", { name: "My Shop" });
    expect(created.status).toBe(201);
    const { project } = await read(created);
    expect(project.slug).toBe("my-shop");

    const keyResponse = await client.post(`/api/projects/${project.id}/keys`, { name: "prod" });
    const { key, secret } = await read(keyResponse);
    expect(secret).toMatch(/^slk_[A-Za-z0-9]{32}$/);
    expect(key).not.toHaveProperty("secret");
    expect(key.prefix).toBe(secret.slice(0, 10));
    expect((await ingest({ events: [{ level: "info", message: "hi" }] }, secret)).status).toBe(202);

    const audit = await read(client.get("/api/audit"));
    const actions = audit.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.login", "auth.password_changed", "project.created", "api_key.created"]));
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it("filters, searches and paginates events", async () => {
    const now = Date.now();
    const events = [
      { level: "info", message: "League loaded", service: "backend", timestamp: new Date(now - 4000).toISOString() },
      { level: "warning", message: "Slow standings query", service: "backend", timestamp: new Date(now - 3000).toISOString(), tags: { league: "a" } },
      { level: "error", message: "Standings failed", service: "frontend", requestId: "req_abcdefgh", timestamp: new Date(now - 2000).toISOString(), tags: { league: "b" } },
      { level: "critical", message: "Database down", service: "backend", requestId: "req_abcdefgh", timestamp: new Date(now - 1000).toISOString() },
    ];
    await ingest({ events });

    const client = browser();
    await client.signInReady();
    const list = async (query: string) => {
      const response = await client.get(`/api/projects/${projectId}/events?${query}`);
      expect(response.status).toBe(200);
      return (await read(response)) as { events: { id: number; message: string }[]; nextCursor: string | null };
    };

    expect((await list("")).events.map((e) => e.message)).toEqual(["Database down", "Standings failed", "Slow standings query", "League loaded"]);
    expect((await list("level=error")).events).toHaveLength(2);
    expect((await list("level=error&exactLevel=1")).events.map((e) => e.message)).toEqual(["Standings failed"]);
    expect((await list("service=backend")).events).toHaveLength(3);
    expect((await list("requestId=req_abcdefgh")).events).toHaveLength(2);
    expect((await list("q=standing")).events).toHaveLength(2);
    expect((await list("tag=league:b")).events.map((e) => e.message)).toEqual(["Standings failed"]);

    const first = await list("limit=3");
    expect(first.events).toHaveLength(3);
    expect(first.nextCursor).toBeTruthy();
    const second = await list(`limit=3&cursor=${first.nextCursor}`);
    expect(second.events.map((e) => e.message)).toEqual(["League loaded"]);
    expect(second.nextCursor).toBeNull();

    const detail = await read(client.get(`/api/projects/${projectId}/events/${first.events[0]!.id}`));
    expect(detail.event).toMatchObject({ level: "critical", service: "backend" });

    const facets = await read(client.get(`/api/projects/${projectId}/facets`));
    expect(facets).toEqual({ services: ["backend", "frontend"], environments: [], tagKeys: ["league"] });

    const stats = await read(client.get(`/api/projects/${projectId}/stats`));
    expect(stats.byLevel).toMatchObject({ info: 1, warning: 1, error: 1, critical: 1 });
    expect(stats.hourly.reduce((n: number, h: { errors: number }) => n + h.errors, 0)).toBe(2);

    expect((await client.get(`/api/projects/${projectId}/events?level=loud`)).status).toBe(400);
  });

  it("spreads the hourly histogram across the whole window", async () => {
    const now = Date.now();
    await ingest({
      events: [
        { level: "error", message: "old", timestamp: new Date(now - 20.5 * 3_600_000).toISOString() },
        { level: "info", message: "mid", timestamp: new Date(now - 5.5 * 3_600_000).toISOString() },
        { level: "info", message: "new", timestamp: new Date(now - 60_000).toISOString() },
      ],
    });
    const client = browser();
    await client.signInReady();
    const stats = await read(client.get(`/api/projects/${projectId}/stats?hours=24`));
    const filled = stats.hourly.map((h: { total: number }) => h.total);
    expect(filled.reduce((a: number, b: number) => a + b, 0)).toBe(3);
    expect(filled[3]).toBe(1);
    expect(stats.hourly[3].errors).toBe(1);
    expect(filled[18]).toBe(1);
    expect(filled[23]).toBe(1);
  });

  it("reports latency percentiles per hour, and leaves untimed hours null", async () => {
    const now = Date.now();
    // 50 timed events of 1..50ms in one hour (the per-minute ingest cap in this
    // config). Nearest rank: p50 -> row 25, p95 -> row 48, p99 -> row 50.
    await ingest({
      events: Array.from({ length: 50 }, (_, i) => ({
        level: "info" as const,
        message: `req ${i}`,
        durationMs: i + 1,
        timestamp: new Date(now - 90 * 60_000).toISOString(),
      })),
    });
    const client = browser();
    await client.signInReady();
    const stats = await read(client.get(`/api/projects/${projectId}/stats?hours=24`));
    const timed = stats.latency.filter((b: { count: number }) => b.count > 0);
    expect(timed).toHaveLength(1);
    expect(timed[0]).toMatchObject({ count: 50, p50: 25, p95: 48, p99: 50 });
    // Every other hour saw no duration at all — a gap, never a zero.
    expect(stats.latency.filter((b: { p95: number | null }) => b.p95 === null)).toHaveLength(23);
  });

  it("groups errors by fingerprint and ranks them by volume", async () => {
    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    await ingest({
      events: [
        ...Array.from({ length: 5 }, (_, i) => ({
          level: "error" as const,
          message: "Timeout talking to upstream",
          error: { name: "TimeoutError", message: "upstream did not answer" },
          service: "api",
          route: "/api/standings",
          timestamp: at(30 + i),
        })),
        { level: "error", message: "Cannot read properties of undefined", error: { name: "TypeError", message: "x is undefined" }, timestamp: at(10) },
        // Warnings and below never enter the group list.
        { level: "warning", message: "slow query", timestamp: at(5) },
      ],
    });
    const client = browser();
    await client.signInReady();
    const stats = await read(client.get(`/api/projects/${projectId}/stats?hours=24`));
    expect(stats.groups).toHaveLength(2);
    expect(stats.groups[0]).toMatchObject({ title: "TimeoutError", count: 5, service: "api", route: "/api/standings", level: "error" });
    expect(stats.groups[1]).toMatchObject({ title: "TypeError", count: 1 });
    expect(stats.groups[0].spark).toHaveLength(24);
    expect(stats.groups[0].spark.reduce((a: number, b: number) => a + b, 0)).toBe(5);
    expect(stats.groups.some((g: { title: string }) => g.title === "slow query")).toBe(false);
  });

  it("creates one incident for repeated events and deduplicates alerts during its cooldown", async () => {
    const now = Date.now();
    await ingest({
      events: [
        { level: "error", message: "Payment provider timed out", service: "api", timestamp: new Date(now - 2_000).toISOString() },
        { level: "error", message: "Payment provider timed out", service: "api", timestamp: new Date(now - 1_000).toISOString() },
      ],
    });
    await ingest({ events: [{ level: "error", message: "Payment provider timed out", service: "api" }] });

    const incidentRows = deps.db.prepare("SELECT status, event_count FROM incidents").all() as { status: string; event_count: number }[];
    expect(incidentRows).toEqual([{ status: "open", event_count: 3 }]);
    expect((deps.db.prepare("SELECT COUNT(*) AS n FROM incident_alerts").get() as { n: number }).n).toBe(1);

    const client = browser();
    await client.signInReady();
    const response = await read(client.get(`/api/projects/${projectId}/incidents`));
    expect(response.incidents).toHaveLength(1);
    expect(response.incidents[0]).toMatchObject({ status: "open", eventCount: 3, level: "error", service: "api", alertCount: 1 });
  });

  it("starts a new incident after the grouping window and can resolve it manually", async () => {
    const now = Date.now();
    await ingest({ events: [{ level: "critical", message: "Database unavailable", timestamp: new Date(now - 31 * 60_000).toISOString() }] });
    await ingest({ events: [{ level: "critical", message: "Database unavailable", timestamp: new Date(now).toISOString() }] });

    const client = browser();
    await client.signInReady();
    const all = await read(client.get(`/api/projects/${projectId}/incidents?status=all`));
    expect(all.incidents).toHaveLength(2);
    expect(all.incidents.filter((incident: { status: string }) => incident.status === "open")).toHaveLength(1);

    const open = all.incidents.find((incident: { status: string }) => incident.status === "open");
    expect(open).toBeTruthy();
    const resolved = await client.post(`/api/projects/${projectId}/incidents/${open.id}/resolve`);
    expect(resolved.status).toBe(200);
    expect((await read(resolved)).incident.status).toBe("resolved");
  });

  it("delivers each queued alert once and leaves no duplicate after a successful send", async () => {
    await ingest({ events: [{ level: "error", message: "Webhook test failure" }] });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(dispatchPendingAlerts(deps.db, "https://alerts.example.test/hook")).resolves.toEqual({ sent: 1, failed: 0 });
      await expect(dispatchPendingAlerts(deps.db, "https://alerts.example.test/hook")).resolves.toEqual({ sent: 0, failed: 0 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[0] === "https://alerts.example.test/hook" ? fetchMock.mock.calls[0]?.[1]?.body : ""));
      expect(body).toMatchObject({ type: "super_logs_incident", incident: { title: "Webhook test failure", alertId: 1 } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requires the slug to delete a project", async () => {
    const client = browser();
    await client.signInReady();
    const url = `/api/projects/${projectId}`;
    expect((await client.call(url, { method: "DELETE", body: "{}" })).status).toBe(400);
    expect((await client.call(url, { method: "DELETE", body: JSON.stringify({ confirm: "fantaf1" }) })).status).toBe(200);
    expect((await ingest({ events: [{ level: "info", message: "x" }] })).status).toBe(401);
  });

  it("reports system health without secrets", async () => {
    expect((await app.request("/api/health")).status).toBe(200);
    const client = browser();
    await client.signInReady();
    const system = await read(client.get("/api/system"));
    expect(system).toMatchObject({ retentionDays: 14, database: { events: 0 } });
  });

  it("sends security headers", async () => {
    const response = await app.request("/api/health");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("storage", () => {
  it("builds safe full-text queries", () => {
    expect(ftsQuery('standings" OR 1=1 --')).toBe('"standings"* AND "OR"* AND "1"* AND "1"*');
    expect(ftsQuery("***")).toBeNull();
  });

  it("deletes events past retention", async () => {
    await ingest({ events: [{ level: "info", message: "old" }, { level: "info", message: "new" }] });
    deps.db.prepare("UPDATE events SET received_at = ? WHERE message = 'old'").run(Date.now() - 20 * 86_400_000);
    expect(deleteExpiredEvents(deps.db, 14)).toBe(1);
    const left = deps.db.prepare("SELECT message FROM events").all() as { message: string }[];
    expect(left.map((r) => r.message)).toEqual(["new"]);
    // The full-text index follows deletions.
    const fts = deps.db.prepare("SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH 'old'").get() as { n: number };
    expect(fts.n).toBe(0);
  });
});
