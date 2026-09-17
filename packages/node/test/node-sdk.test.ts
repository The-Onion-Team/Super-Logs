import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserRelay, createSuperLogs, currentContext, type SuperLogsEvent } from "@super-logs/node";

type Sent = { url: string; headers: Record<string, string>; events: SuperLogsEvent[] };

function fakeFetch(status = 202, sent: Sent[] = []) {
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      events: JSON.parse(String(init?.body)).events,
    });
    return new Response(null, { status });
  });
  return { fn: fn as unknown as typeof fetch, sent, mock: fn };
}

const spoolDir = mkdtempSync(join(tmpdir(), "sl-test-"));
const loggers: { shutdown(): Promise<void> }[] = [];
function make(opts: Partial<Parameters<typeof createSuperLogs>[0]> = {}) {
  const logger = createSuperLogs({
    url: "https://logs.example.com",
    apiKey: "slk_test",
    service: "api",
    environment: "test",
    flushIntervalMs: 60_000,
    spoolDir,
    onTransportError: () => {},
    ...opts,
  });
  loggers.push(logger);
  return logger;
}

afterEach(async () => {
  for (const logger of loggers.splice(0)) await logger.shutdown(100);
});

describe("node SDK", () => {
  it("is a silent no-op without url or key", async () => {
    const { fn, mock } = fakeFetch();
    const logger = createSuperLogs({ service: "api", fetch: fn });
    logger.error("nothing happens");
    await logger.flush();
    expect(logger.enabled).toBe(false);
    expect(mock).not.toHaveBeenCalled();
  });

  it("batches structured events with metadata, context and redaction", async () => {
    const { fn, sent } = fakeFetch();
    const logger = make({ fetch: fn, release: "abc123", tags: { region: "eu" } });
    const error = new Error("connection refused", { cause: new Error("ECONNREFUSED") });
    logger.withContext({ requestId: "req_12345678", tags: { league: "main" } }, () => {
      logger.error("Database query failed", { error, queryName: "getLeague", password: "pw", httpStatus: 500 });
    });
    logger.debug("below min level");
    await logger.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://logs.example.com/api/ingest");
    expect(sent[0]!.headers.authorization).toBe("Bearer slk_test");
    const [event] = sent[0]!.events;
    expect(event).toMatchObject({
      level: "error",
      message: "Database query failed",
      service: "api",
      environment: "test",
      release: "abc123",
      requestId: "req_12345678",
      httpStatus: 500,
      tags: { region: "eu", league: "main" },
      metadata: { queryName: "getLeague", password: "[REDACTED]" },
      error: { name: "Error", message: "connection refused" },
    });
    expect(event!.error!.stack).toContain("Caused by: Error: ECONNREFUSED");
    expect(sent[0]!.events).toHaveLength(1);
  });

  it("reports the same Error object only once", async () => {
    const { fn, sent } = fakeFetch();
    const logger = make({ fetch: fn });
    const error = new Error("once");
    logger.captureException(error);
    logger.captureException(error);
    await logger.flush();
    expect(sent.flatMap((s) => s.events)).toHaveLength(1);
  });

  it("keeps events and backs off when the server is down", async () => {
    const { fn, mock } = fakeFetch(503);
    const logger = make({ fetch: fn });
    logger.error("a");
    await logger.flush();
    await logger.flush(); // still in backoff: no second request
    expect(mock).toHaveBeenCalledTimes(1);
    expect(logger.stats()).toMatchObject({ queued: 1, sent: 0 });
    expect(logger.stats()?.backoffUntil).toBeTruthy();
  });

  it("never throws when fetch rejects", async () => {
    const logger = make({ fetch: (async () => { throw new Error("offline"); }) as typeof fetch });
    expect(() => logger.error("x")).not.toThrow();
    await expect(logger.flush()).resolves.toBeUndefined();
  });

  it("drops the oldest events when the queue is full", async () => {
    const { fn, sent } = fakeFetch();
    const logger = make({ fetch: fn, maxQueueSize: 3, batchSize: 100 });
    for (const n of [1, 2, 3, 4, 5]) logger.info(`e${n}`);
    await logger.flush();
    expect(sent.flatMap((s) => s.events).map((e) => e.message)).toEqual(["e3", "e4", "e5"]);
    expect(logger.stats()?.dropped).toBe(2);
  });

  it("captures console.error without changing its output", async () => {
    const { fn, sent } = fakeFetch();
    const original = console.error;
    const printed: unknown[][] = [];
    console.error = (...args: unknown[]) => void printed.push(args);
    try {
      const logger = make({ fetch: fn, captureConsole: ["error"] });
      console.error("[jobs] failed for league %s", "main", new Error("boom"));
      console.error("plain text");
      expect(printed).toHaveLength(2);
      await new Promise((resolve) => setImmediate(resolve));
      await logger.flush();
      await logger.shutdown(10);
      const events = sent.flatMap((s) => s.events);
      expect(events.map((e) => e.message)).toEqual(["plain text", "[jobs] failed for league main Error: boom"]);
      expect(events[1]).toMatchObject({ level: "error", event: "console.error", error: { message: "boom" } });
      expect(events[1]!.error!.stack).toContain("node-sdk.test.ts");
    } finally {
      console.error = original;
    }
  });

  it("lets an explicit capture of a logged error win over the console copy", async () => {
    const { fn, sent } = fakeFetch();
    const original = console.error;
    console.error = () => {};
    try {
      const logger = make({ fetch: fn, captureConsole: ["error"] });
      const error = new Error("render failed");
      console.error(error);
      logger.captureException(error, { event: "next_request_error", route: "/league/[id]" });
      await new Promise((resolve) => setImmediate(resolve));
      await logger.flush();
      await logger.shutdown(10);
      const events = sent.flatMap((s) => s.events);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event: "next_request_error", route: "/league/[id]" });
    } finally {
      console.error = original;
    }
  });

  it("sends events spooled by a previous crash on start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sl-spool-"));
    const file = join(dir, "super-logs-crashy.spool.jsonl");
    writeFileSync(file, `${JSON.stringify({ level: "critical", message: "died" })}\n{torn`);
    const { fn, sent } = fakeFetch();
    const logger = make({ fetch: fn, service: "crashy", spoolDir: dir });
    await logger.flush();
    expect(sent[0]!.events).toEqual([{ level: "critical", message: "died" }]);
    expect(existsSync(file)).toBe(false);
  });
});

describe("runWithRequest", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("correlates a request, echoes the id and logs 5xx", async () => {
    const { fn, sent } = fakeFetch();
    const logger = make({ fetch: fn });
    let seen: string | undefined;
    server = createServer((req, res) =>
      logger.runWithRequest(req, res, () => {
        seen = currentContext()?.requestId;
        logger.info("inside");
        res.statusCode = 500;
        res.end();
      }),
    );
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const echoed = await new Promise<string | undefined>((resolve, reject) => {
      const req = httpRequest({ port, path: "/standings?x=1", headers: { "x-request-id": "req_fromclient1" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.headers["x-request-id"] as string | undefined));
      });
      req.on("error", reject);
      req.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await logger.flush();

    expect(seen).toBe("req_fromclient1");
    expect(echoed).toBe("req_fromclient1");
    const events = sent.flatMap((s) => s.events);
    expect(events.map((e) => e.message)).toEqual(["inside", "GET /standings → 500"]);
    expect(events.every((e) => e.requestId === "req_fromclient1" && e.route === "/standings")).toBe(true);
  });
});

describe("browser relay", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://app.example.com/api/telemetry", {
      method: "POST",
      headers: { origin: "https://app.example.com", host: "app.example.com", "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("sanitises, enriches and forwards browser events", async () => {
    const { fn, sent } = fakeFetch();
    const logger = make({ fetch: fn });
    const relay = createBrowserRelay(logger, { enrich: () => ({ userId: "acc_1", tags: { league: "main" } }) });
    const response = await relay(
      post({
        events: [
          {
            level: "critical",
            message: "Render failed",
            route: "/team?secret=1",
            userId: "spoofed",
            service: "spoofed",
            sessionId: "sess_abcdefgh",
            evil: "<script>",
            metadata: { token: "abc" },
          },
          { level: "nope", message: "dropped" },
        ],
      }),
    );
    await logger.flush();
    expect(response.status).toBe(204);
    const events = sent.flatMap((s) => s.events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      level: "error", // capped at maxLevel
      service: "api-web",
      environment: "test",
      route: "/team",
      userId: "acc_1",
      sessionId: "sess_abcdefgh",
      tags: { league: "main" },
      metadata: { token: "[REDACTED]" },
    });
    expect(events[0]).not.toHaveProperty("evil");
  });

  it("rejects cross-origin posts, bad JSON and floods", async () => {
    const logger = make({ fetch: fakeFetch().fn });
    const relay = createBrowserRelay(logger, { eventsPerMinute: 2 });
    expect((await relay(post({ events: [] }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await relay(post("{not json"))).status).toBe(400);
    const one = { events: [{ level: "error", message: "x" }] };
    expect((await relay(post(one))).status).toBe(204);
    expect((await relay(post(one))).status).toBe(204);
    expect((await relay(post(one))).status).toBe(429);
    expect((await relay(new Request("https://app.example.com/api/telemetry"))).status).toBe(405);
  });
});
