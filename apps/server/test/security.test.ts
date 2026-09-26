import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, createDeps, isPrivateAddress, type AppDeps } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db/index.js";
import { proxyObservation } from "../src/lib/metrics.js";
import { createUser, ensureAdmin } from "../src/services/auth.js";
import { createKey, createProject } from "../src/services/projects.js";
import { dispatchPendingAlerts } from "../src/services/incidents.js";
import { webhookChannel } from "../src/services/alerts.js";
import { postureChecks } from "../src/services/posture.js";
import {
  DETECTION_WINDOW_MS,
  FINDING_QUIET_MS,
  deleteExpiredSecurityData,
  deliverSelfAlerts,
  listFindings,
  recordSignals,
  securityActivity,
  securityCounts,
  resolveFinding,
  runDetection,
} from "../src/services/security.js";
import { selfAlertChannels } from "../src/jobs.js";
import { formatTelegramMessage } from "../src/services/telegram.js";

const ORIGIN = "https://logs.example.com";
const ADMIN = { email: "admin@example.com", password: "correct horse battery" };
const NEW_PASSWORD = "a brand new passphrase";
const COOLDOWN = 15 * 60_000;

let deps: AppDeps;
let app: ReturnType<typeof createApp>;
let projectId: string;
let apiKey: string;

beforeEach(async () => {
  const config = loadConfig({
    SUPER_LOGS_PUBLIC_URL: ORIGIN,
    SUPER_LOGS_DATA_DIR: "/tmp/unused",
    SUPER_LOGS_LOG_LEVEL: "error",
  });
  const db = openDatabase(":memory:");
  await ensureAdmin(db, ADMIN);
  deps = createDeps(db, config);
  app = createApp(deps);
  projectId = createProject(db, "FantaF1").id;
  apiKey = createKey(db, projectId, "backend").secret;
  proxyObservation.publicSourceAt = null;
  proxyObservation.publicSource = null;
  proxyObservation.ignoredHeaderAt = null;
});

const read = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

const ingest = (body: unknown, key = apiKey, headers: Record<string, string> = {}) =>
  app.request("/api/ingest", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const signal = (kind: string, ip: string, extra: Record<string, unknown> = {}) => ({
  level: "info",
  message: `Security signal: ${kind}`,
  event: `security.${kind}`,
  route: "/api/login",
  method: "POST",
  httpStatus: 401,
  ...extra,
  security: { signal: kind, ip, userAgent: "curl/8.0", ...(extra.security as object | undefined) },
});

function browser(ip = "203.0.113.50") {
  let cookie = "";
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await app.request(path, {
      ...init,
      headers: {
        origin: ORIGIN,
        "x-super-logs-csrf": "1",
        "content-type": "application/json",
        "x-forwarded-for": ip,
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0",
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
    signIn(password = ADMIN.password, email = ADMIN.email) {
      return call("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    },
    async signInReady() {
      await this.signIn();
      const changed = await this.post("/api/auth/password", { currentPassword: ADMIN.password, newPassword: NEW_PASSWORD });
      expect(changed.status).toBe(200);
    },
  };
}

const count = (sql: string, ...params: (string | number)[]) => (deps.db.prepare(sql).get(...params) as { n: number }).n;
const detect = (now = Date.now()) => runDetection(deps.db, { now, alertCooldownMs: COOLDOWN });

describe("security signals on ingest", () => {
  it("stores signals in their own table and never as log events", async () => {
    const result = await read(ingest({ events: [signal("auth_failed", "198.51.100.7"), { level: "info", message: "ordinary" }] }));
    expect(result).toMatchObject({ accepted: 2, rejected: 0 });
    expect(count("SELECT COUNT(*) AS n FROM security_signals WHERE project_id = ? AND ip = '198.51.100.7'", projectId)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM events")).toBe(1);
    const stored = deps.db.prepare("SELECT * FROM events").all();
    expect(JSON.stringify(stored)).not.toContain("198.51.100.7");
  });

  it("rejects a signal whose address or account is not what it claims to be", async () => {
    const bad = await read(
      ingest({
        events: [
          signal("probe", "<script>"),
          signal("login_failed", "198.51.100.7", { security: { account: "someone@example.com" } }),
          { ...signal("probe", "198.51.100.7"), security: { signal: "made_up" } },
        ],
      }),
    );
    expect(bad).toMatchObject({ accepted: 0, rejected: 3 });
    expect(count("SELECT COUNT(*) AS n FROM security_signals")).toBe(0);
  });

  it("maps IPv4-in-IPv6 to plain IPv4", async () => {
    await ingest({ events: [signal("probe", "::ffff:198.51.100.7")] });
    expect(deps.db.prepare("SELECT ip FROM security_signals").get()).toMatchObject({ ip: "198.51.100.7" });
  });

  it("records a bad ingest key as a signal about Super-Logs itself", async () => {
    expect((await ingest({ events: [] }, "slk_wrong", { "x-forwarded-for": "192.0.2.9" })).status).toBe(401);
    expect(deps.db.prepare("SELECT project_id, kind, ip FROM security_signals").get()).toMatchObject({
      project_id: null,
      kind: "bad_api_key",
      ip: "192.0.2.9",
    });
  });
});

describe("detection", () => {
  it("opens a finding at the threshold and not one request before", async () => {
    await ingest({ events: Array.from({ length: 19 }, () => signal("auth_failed", "198.51.100.7")) });
    expect(detect().opened).toBe(0);
    await ingest({ events: [signal("auth_failed", "198.51.100.7")] });
    expect(detect().opened).toBe(1);
    const [finding] = listFindings(deps.db, { status: "open" });
    expect(finding).toMatchObject({ rule: "brute_force", ip: "198.51.100.7", level: "warning", signalCount: 20, projectName: "FantaF1" });
    expect(finding!.detail?.routes).toEqual([{ route: "/api/login", count: 20 }]);
  });

  it("keeps one open finding per project, rule and address, and escalates it", async () => {
    await ingest({ events: Array.from({ length: 20 }, () => signal("auth_failed", "198.51.100.7")) });
    detect();
    // Five different accounts from one address is credential stuffing.
    await ingest({
      events: Array.from({ length: 5 }, (_, i) => signal("login_failed", "198.51.100.7", { security: { account: `acc_${i}` } })),
    });
    const second = detect();
    expect(second).toMatchObject({ opened: 0, updated: 1 });
    const findings = listFindings(deps.db, { status: "open" });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: "critical", signalCount: 25 });
  });

  it("detects scanners and error floods separately, per address", async () => {
    await ingest({ events: Array.from({ length: 10 }, () => signal("probe", "198.51.100.1", { route: "/.env", httpStatus: 404 })) });
    await ingest({ events: Array.from({ length: 9 }, () => signal("probe", "198.51.100.2", { route: "/.env", httpStatus: 404 })) });
    await ingest({ events: Array.from({ length: 20 }, () => signal("server_error", "198.51.100.3", { httpStatus: 500 })) });
    expect(detect().opened).toBe(2);
    const rules = listFindings(deps.db, { status: "open" }).map((f) => `${f.rule}:${f.ip}`).sort();
    expect(rules).toEqual(["error_flood:198.51.100.3", "scanner:198.51.100.1"]);
  });

  it("only counts signals inside the window", () => {
    const now = Date.now();
    recordSignals(
      deps.db,
      projectId,
      Array.from({ length: 30 }, () => ({ kind: "probe", ts: now - DETECTION_WINDOW_MS - 1000, ip: "198.51.100.1" })),
    );
    expect(detect(now).opened).toBe(0);
  });

  it("resolves a quiet finding, and does not reopen one resolved by hand for the same requests", async () => {
    const now = Date.now();
    recordSignals(deps.db, projectId, Array.from({ length: 10 }, () => ({ kind: "probe", ts: now - 1000, ip: "198.51.100.1" })));
    detect(now);
    const [finding] = listFindings(deps.db, { status: "open" });
    expect(resolveFinding(deps.db, finding!.id, now)).toBe(true);
    expect(detect(now + 1000).opened).toBe(0);

    // New requests after the resolution count again.
    recordSignals(deps.db, projectId, Array.from({ length: 10 }, () => ({ kind: "probe", ts: now + 2000, ip: "198.51.100.1" })));
    expect(detect(now + 3000).opened).toBe(1);

    expect(detect(now + 3000 + FINDING_QUIET_MS + 1000).resolved).toBe(1);
    expect(listFindings(deps.db, { status: "open" })).toHaveLength(0);
  });

  it("keeps a finding open while the address keeps going below the threshold", () => {
    const now = Date.now();
    recordSignals(deps.db, projectId, Array.from({ length: 10 }, () => ({ kind: "probe", ts: now, ip: "198.51.100.1" })));
    detect(now);
    const later = now + FINDING_QUIET_MS - 60_000;
    recordSignals(deps.db, projectId, [{ kind: "probe", ts: later, ip: "198.51.100.1" }]);
    detect(later);
    expect(detect(now + FINDING_QUIET_MS + 1000).resolved).toBe(0);
    expect(listFindings(deps.db, { status: "open" })[0]).toMatchObject({ signalCount: 11 });
  });
});

describe("alerts for findings", () => {
  it("raises one incident in the app's log, without the address, and links to the Security page", async () => {
    await ingest({ events: Array.from({ length: 10 }, () => signal("probe", "198.51.100.1", { route: "/.env", httpStatus: 404 })) });
    expect(detect().appAlerts).toBe(1);
    // The next pass is inside the cooldown: nothing new.
    expect(detect().appAlerts).toBe(0);

    const event = deps.db.prepare("SELECT * FROM events WHERE event = 'security.scanner'").get() as Record<string, unknown>;
    expect(event).toBeTruthy();
    expect(event.level).toBe(30);
    expect(JSON.stringify(event)).not.toContain("198.51.100.1");
    expect(count("SELECT COUNT(*) AS n FROM incident_alerts")).toBe(1);

    const sent: unknown[] = [];
    const channel = { name: "test", send: async (alert: unknown) => void sent.push(alert) };
    await dispatchPendingAlerts(deps.db, () => [channel]);
    expect(sent).toHaveLength(1);
    const alert = sent[0] as Parameters<typeof formatTelegramMessage>[0];
    expect(alert.event).toBe("security.scanner");
    expect(formatTelegramMessage(alert, ORIGIN)).toContain(`${ORIGIN}/security`);
  });

  it("alerts again after the cooldown only if the attack continued", () => {
    const now = Date.now();
    recordSignals(deps.db, projectId, Array.from({ length: 10 }, () => ({ kind: "probe", ts: now, ip: "198.51.100.1" })));
    expect(detect(now).appAlerts).toBe(1);
    expect(detect(now + COOLDOWN + 1000).appAlerts).toBe(0);
    recordSignals(deps.db, projectId, [{ kind: "probe", ts: now + COOLDOWN + 2000, ip: "198.51.100.1" }]);
    expect(detect(now + COOLDOWN + 3000).appAlerts).toBe(1);
  });

  it("sends findings about Super-Logs itself to every configured channel, once each", async () => {
    // Two projects share one Telegram chat; a third has its own.
    const other = createProject(deps.db, "Other").id;
    const third = createProject(deps.db, "Third").id;
    const insert = deps.db.prepare(
      `INSERT INTO notification_channels (id, project_id, kind, enabled, min_level, settings, created_at, updated_at)
       VALUES (?, ?, 'telegram', 1, 'warning', ?, 0, 0)`,
    );
    const token = "123456789:AAFakeTokenForTestsOnly-0123456789";
    insert.run("nch_a", projectId, JSON.stringify({ botToken: token, chatId: "-100111" }));
    insert.run("nch_b", other, JSON.stringify({ botToken: token, chatId: "-100111" }));
    insert.run("nch_c", third, JSON.stringify({ botToken: token, chatId: "-100222" }));
    const channels = selfAlertChannels(deps.db, { ...deps.config, telegramApiBaseUrl: "https://telegram.example.test" });
    expect(channels).toHaveLength(2);

    const client = browser("192.0.2.66");
    for (let i = 0; i < 5; i++) await client.signIn(`wrong password ${i}`);
    detect();
    const [finding] = listFindings(deps.db, { status: "open", project: "self" });
    expect(finding).toMatchObject({ rule: "dashboard_brute_force", ip: "192.0.2.66", level: "critical" });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(deliverSelfAlerts(deps.db, channels, { alertCooldownMs: COOLDOWN })).resolves.toEqual({ sent: 2, failed: 0 });
      const chats = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).chat_id).sort();
      expect(chats).toEqual(["-100111", "-100222"]);
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).text).toContain("192.0.2.66");
      // Within the cooldown nothing is resent.
      await expect(deliverSelfAlerts(deps.db, channels, { alertCooldownMs: COOLDOWN })).resolves.toEqual({ sent: 0, failed: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not repeat a self alert every minute when a channel fails", async () => {
    recordSignals(deps.db, null, Array.from({ length: 5 }, () => ({ kind: "login_failed", ts: Date.now(), ip: "192.0.2.66" })));
    detect();
    const broken = webhookChannel("https://alerts.example.test/hook");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    try {
      await expect(deliverSelfAlerts(deps.db, [broken], { alertCooldownMs: COOLDOWN })).resolves.toEqual({ sent: 0, failed: 1 });
      await expect(deliverSelfAlerts(deps.db, [broken], { alertCooldownMs: COOLDOWN })).resolves.toEqual({ sent: 0, failed: 0 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("dashboard sign-ins", () => {
  it("records failures, lock-outs and sign-ins with the client address", async () => {
    const client = browser("192.0.2.10");
    for (let i = 0; i < 5; i++) await client.signIn(`wrong password ${i}`);
    expect((await client.signIn()).status).toBe(429);
    const kinds = deps.db.prepare("SELECT kind, ip, account FROM security_signals ORDER BY id").all() as { kind: string; ip: string }[];
    expect(kinds.map((k) => k.kind)).toEqual([...Array(5).fill("login_failed"), "rate_limited"]);
    expect(new Set(kinds.map((k) => k.ip))).toEqual(new Set(["192.0.2.10"]));
  });

  it("flags a sign-in from an address this account has not used before", async () => {
    await browser("192.0.2.10").signIn();
    await browser("192.0.2.10").signIn();
    expect(listFindings(deps.db, { status: "open" })).toHaveLength(0);
    await browser("198.51.100.200").signIn();
    const [finding] = listFindings(deps.db, { status: "open" });
    expect(finding).toMatchObject({ rule: "new_ip_sign_in", ip: "198.51.100.200", level: "info", projectId: null });
    expect(finding!.detail).toMatchObject({ account: ADMIN.email });
  });

  it("stores the address on the session", async () => {
    await browser("192.0.2.10").signIn();
    expect(deps.db.prepare("SELECT ip FROM sessions").get()).toMatchObject({ ip: "192.0.2.10" });
  });

  it("caps how many signals one address can write", async () => {
    const now = Date.now();
    for (let i = 0; i < 100; i++) {
      await ingest({ events: [] }, "slk_wrong", { "x-forwarded-for": "192.0.2.9" });
    }
    expect(count("SELECT COUNT(*) AS n FROM security_signals")).toBe(60);
    expect(Date.now() - now).toBeLessThan(60_000);
  });
});

describe("security API", () => {
  it("is for administrators only", async () => {
    await createUser(deps.db, { email: "viewer@example.com", password: "a viewer passphrase", role: "viewer" });
    const viewer = browser();
    await viewer.signIn("a viewer passphrase", "viewer@example.com");
    for (const path of ["/api/security/overview", "/api/security/findings", "/api/security/sessions", "/api/security/sign-ins"]) {
      expect((await viewer.get(path)).status).toBe(403);
    }
    expect((await browser().get("/api/security/overview")).status).toBe(401);
  });

  it("lists findings with their requests, and resolves them with an audit entry", async () => {
    const client = browser();
    await client.signInReady();
    await ingest({ events: Array.from({ length: 10 }, () => signal("probe", "198.51.100.1", { route: "/wp-login.php", httpStatus: 404 })) });
    detect();

    const { findings } = await read(client.get("/api/security/findings"));
    expect(findings).toHaveLength(1);
    const detail = await read(client.get(`/api/security/findings/${findings[0].id}`));
    expect(detail.signals).toHaveLength(10);
    expect(detail.signals[0]).toMatchObject({ kind: "probe", route: "/wp-login.php", httpStatus: 404, ip: "198.51.100.1" });

    expect((await client.post(`/api/security/findings/${findings[0].id}/resolve`)).status).toBe(200);
    expect((await read(client.get("/api/security/findings"))).findings).toHaveLength(0);
    expect((await read(client.get("/api/security/findings?status=resolved"))).findings).toHaveLength(1);
    expect(count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'security.finding_resolved'")).toBe(1);

    const overview = await read(client.get("/api/security/overview"));
    expect(overview.counts).toMatchObject({ openFindings: 0, signals24h: 10 });
    expect(overview.posture.map((check: { id: string }) => check.id)).toContain("https");
  });

  it("lists open findings first, the most severe at the top", async () => {
    const client = browser();
    await client.signInReady();
    const now = Date.now();
    recordSignals(deps.db, projectId, Array.from({ length: 10 }, () => ({ kind: "probe", ts: now - 5_000, ip: "198.51.100.1" })));
    recordSignals(deps.db, null, Array.from({ length: 5 }, () => ({ kind: "login_failed", ts: now - 60_000, ip: "192.0.2.66" })));
    detect(now);
    await browser("198.51.100.200").signIn(NEW_PASSWORD);
    const rules = (await read(client.get("/api/security/findings"))).findings.map((f: { rule: string }) => f.rule);
    expect(rules).toEqual(["dashboard_brute_force", "scanner", "new_ip_sign_in"]);
  });

  it("filters findings to Super-Logs itself or to one project", async () => {
    const client = browser();
    await client.signInReady();
    recordSignals(deps.db, null, Array.from({ length: 5 }, () => ({ kind: "login_failed", ts: Date.now(), ip: "192.0.2.66" })));
    recordSignals(deps.db, projectId, Array.from({ length: 10 }, () => ({ kind: "probe", ts: Date.now(), ip: "198.51.100.1" })));
    detect();
    expect((await read(client.get("/api/security/findings?project=self"))).findings.map((f: { rule: string }) => f.rule)).toEqual([
      "dashboard_brute_force",
    ]);
    expect((await read(client.get(`/api/security/findings?project=${projectId}`))).findings.map((f: { rule: string }) => f.rule)).toEqual([
      "scanner",
    ]);
  });

  it("lists sessions and revokes another one, but not its own", async () => {
    const mine = browser("192.0.2.10");
    await mine.signInReady();
    const other = browser("192.0.2.20");
    await other.signIn(NEW_PASSWORD);
    expect((await other.get("/api/auth/me")).status).toBe(200);

    const { sessions } = await read(mine.get("/api/security/sessions"));
    expect(sessions).toHaveLength(2);
    const current = sessions.find((s: { current: boolean }) => s.current);
    const theirs = sessions.find((s: { current: boolean }) => !s.current);
    expect(theirs.ip).toBe("192.0.2.20");
    expect(JSON.stringify(sessions)).not.toMatch(/[0-9a-f]{64}/);

    expect((await mine.call(`/api/security/sessions/${current.id}`, { method: "DELETE" })).status).toBe(400);
    expect((await mine.call(`/api/security/sessions/${theirs.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await other.get("/api/auth/me")).status).toBe(401);
    expect((await mine.get("/api/auth/me")).status).toBe(200);
  });

  it("signs out every other session", async () => {
    const mine = browser();
    await mine.signInReady();
    const other = browser("192.0.2.20");
    await other.signIn(NEW_PASSWORD);
    expect(await read(mine.post("/api/security/sessions/revoke-others"))).toEqual({ revoked: 1 });
    expect((await other.get("/api/auth/me")).status).toBe(401);
    expect((await mine.get("/api/auth/me")).status).toBe(200);
  });
});

describe("posture", () => {
  const check = (id: string, config = deps.config) => postureChecks(deps.db, config).find((c) => c.id === id);

  it("warns about the first-boot password until it is changed", async () => {
    expect(check("bootstrap-password")?.status).toBe("warn");
    await browser().signInReady();
    expect(check("bootstrap-password")?.status).toBe("ok");
  });

  it("warns when the admin password is still in the environment", () => {
    expect(check("env-admin-password")).toBeUndefined();
    expect(check("env-admin-password", { ...deps.config, admin: ADMIN })?.status).toBe("warn");
  });

  it("warns when forwarded addresses arrive from a public address", async () => {
    const withRemote = createApp(createDeps(deps.db, deps.config, () => "8.8.4.4"));
    await withRemote.request("/api/auth/login", {
      method: "POST",
      headers: { origin: ORIGIN, "x-super-logs-csrf": "1", "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
      body: JSON.stringify({ email: "x@example.com", password: "nope nope nope" }),
    });
    expect(check("proxy")).toMatchObject({ status: "warn" });
    expect(check("proxy")?.detail).toContain("8.8.4.4");
  });

  it("does not warn when the proxy is on a private network", async () => {
    const withRemote = createApp(createDeps(deps.db, deps.config, () => "172.18.0.3"));
    const response = await withRemote.request("/api/auth/login", {
      method: "POST",
      headers: { origin: ORIGIN, "x-super-logs-csrf": "1", "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
      body: JSON.stringify({ email: "x@example.com", password: "nope nope nope" }),
    });
    expect(response.status).toBe(401);
    // The forwarded address was used, and the proxy was not reported.
    expect(deps.db.prepare("SELECT ip FROM security_signals").get()).toMatchObject({ ip: "1.2.3.4" });
    expect(proxyObservation.publicSourceAt).toBeNull();
    expect(check("proxy")?.status).toBe("info");
  });

  it("warns when a proxy header is ignored", async () => {
    const config = { ...deps.config, trustProxy: false };
    const direct = createApp(createDeps(deps.db, config, () => "172.18.0.3"));
    await direct.request("/api/auth/login", {
      method: "POST",
      headers: { origin: ORIGIN, "x-super-logs-csrf": "1", "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
      body: JSON.stringify({ email: "x@example.com", password: "nope nope nope" }),
    });
    expect(check("proxy", config)).toMatchObject({ status: "warn", title: expect.stringContaining("TRUST_PROXY is off") });
  });

  it("lists ingest keys that are never used", () => {
    deps.db.prepare("UPDATE api_keys SET created_at = ?").run(new Date(Date.now() - 10 * 86_400_000).toISOString());
    expect(check("api-keys")).toMatchObject({ status: "warn", detail: expect.stringContaining("FantaF1 / backend") });
  });

  it("knows private addresses from public ones", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "::1", "fd00::1", "::ffff:10.0.0.1", "100.64.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1", "104.16.0.1"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("activity and counts", () => {
  it("buckets the last 24 hours by kind, oldest first, with empty hours as zero", () => {
    const now = Date.UTC(2026, 8, 26, 9, 30);
    recordSignals(deps.db, projectId, [
      { kind: "probe", ts: now - 60_000, ip: "198.51.100.1" },
      { kind: "probe", ts: now - 60_000, ip: "198.51.100.1" },
      { kind: "auth_failed", ts: now - 3 * 3_600_000, ip: "198.51.100.2" },
      { kind: "server_error", ts: now - 3 * 3_600_000, ip: "198.51.100.2" },
      // Older than the window, and a successful sign-in: neither counts.
      { kind: "probe", ts: now - 25 * 3_600_000, ip: "198.51.100.1" },
    ]);
    recordSignals(deps.db, null, [
      { kind: "login_failed", ts: now - 60_000, ip: "192.0.2.1" },
      { kind: "rate_limited", ts: now - 60_000, ip: "192.0.2.1" },
      { kind: "sign_in", ts: now - 60_000, ip: "192.0.2.10" },
    ]);
    const activity = securityActivity(deps.db, 24, now);
    expect(activity).toHaveLength(24);
    expect(activity[23]).toEqual({ start: "2026-09-26T09:00:00.000Z", probes: 2, signIns: 1, denied: 1, errors: 0 });
    expect(activity[20]).toMatchObject({ start: "2026-09-26T06:00:00.000Z", denied: 1, errors: 1 });
    expect(activity[0]!.start).toBe("2026-09-25T10:00:00.000Z");
    expect(activity.slice(0, 20).every((b) => b.probes + b.signIns + b.denied + b.errors === 0)).toBe(true);

    expect(securityCounts(deps.db, now)).toMatchObject({ signals24h: 6, failedSignIns24h: 1, lockedOut24h: 1, openFindings: 0 });
  });

  it("counts attacking addresses, and keeps informational findings apart", async () => {
    recordSignals(deps.db, projectId, Array.from({ length: 10 }, () => ({ kind: "probe", ts: Date.now(), ip: "198.51.100.1" })));
    recordSignals(deps.db, null, Array.from({ length: 5 }, () => ({ kind: "login_failed", ts: Date.now(), ip: "192.0.2.66" })));
    detect();
    await browser("192.0.2.10").signIn();
    await browser("198.51.100.200").signIn();
    expect(securityCounts(deps.db)).toMatchObject({ openFindings: 3, openCritical: 1, openInfo: 1, attackingAddresses24h: 2 });
  });
});

describe("security retention", () => {
  it("deletes old signals and resolved findings, and keeps the rest", () => {
    const now = Date.now();
    const old = now - 8 * 86_400_000;
    recordSignals(deps.db, projectId, [
      { kind: "probe", ts: old, ip: "198.51.100.1" },
      { kind: "probe", ts: now, ip: "198.51.100.1" },
    ]);
    deps.db
      .prepare(
        `INSERT INTO security_findings (id, project_id, rule, ip, level, status, first_seen_at, last_seen_at, signal_count)
         VALUES ('sec_old', ?, 'scanner', '198.51.100.1', 30, 'resolved', ?, ?, 10)`,
      )
      .run(projectId, old, old);
    expect(deleteExpiredSecurityData(deps.db, 7, now)).toEqual({ signals: 1, findings: 1 });
    expect(count("SELECT COUNT(*) AS n FROM security_signals")).toBe(1);
  });
});
