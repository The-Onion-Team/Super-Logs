// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuperLogs, getSuperLogs, parseUserAgent, type SuperLogsEvent } from "@super-logs/browser";

type Call = { url: string; init?: RequestInit };
let calls: Call[];
let nextStatus: number;

const sentEvents = (): SuperLogsEvent[] =>
  calls.filter((c) => c.url.endsWith("/api/telemetry")).flatMap((c) => JSON.parse(String(c.init?.body)).events);

beforeEach(() => {
  calls = [];
  nextStatus = 200;
  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : new URL(String(input), location.href).href;
    calls.push({ url, init });
    return new Response(null, { status: url.endsWith("/api/telemetry") ? 204 : nextStatus });
  }) as typeof fetch;
});

afterEach(() => {
  getSuperLogs().shutdown();
});

describe("browser SDK", () => {
  it("installs once and batches events to the relay", async () => {
    const logs = createSuperLogs({ endpoint: "/api/telemetry", release: "1.0", tags: { app: "test" } });
    expect(createSuperLogs({ endpoint: "/other" })).toBe(logs);
    logs.info("hello", { lot: 3, password: "pw" });
    await logs.flush();
    const [event] = sentEvents();
    expect(event).toMatchObject({
      level: "info",
      message: "hello",
      release: "1.0",
      route: location.pathname,
      sessionId: logs.sessionId,
      tags: { app: "test" },
      metadata: { lot: 3, password: "[REDACTED]" },
    });
    expect(event!.client?.viewport).toMatch(/^\d+x\d+$/);
  });

  it("adds a request id to same-origin requests and reports 5xx with it", async () => {
    const logs = createSuperLogs({ endpoint: "/api/telemetry" });
    nextStatus = 500;
    await fetch("/api/standings?league=1");
    await fetch("https://third-party.example/x");
    await logs.flush();

    const sameOrigin = calls.find((c) => c.url.includes("/api/standings"))!;
    const requestId = new Headers(sameOrigin.init?.headers).get("x-request-id");
    expect(requestId).toMatch(/^req_[0-9a-f]{32}$/);
    const thirdParty = calls.find((c) => c.url.includes("third-party"))!;
    expect(new Headers(thirdParty.init?.headers).has("x-request-id")).toBe(false);

    const events = sentEvents();
    const failed = events.find((e) => e.event === "api_request_failed" && e.message.includes("/api/standings"));
    expect(failed).toMatchObject({ level: "error", requestId, method: "GET", httpStatus: 500, metadata: { endpoint: "/api/standings" } });
    // The query string never leaves the page.
    expect(JSON.stringify(events)).not.toContain("league=1");
  });

  it("does not track its own delivery requests", async () => {
    const logs = createSuperLogs({ endpoint: "/api/telemetry" });
    logs.error("boom");
    await logs.flush();
    expect(sentEvents().map((e) => e.message)).toEqual(["boom"]);
  });

  it("drops repeats and known noise", async () => {
    const logs = createSuperLogs({ endpoint: "/api/telemetry" });
    for (let i = 0; i < 5; i++) logs.error("render loop");
    logs.error("ResizeObserver loop completed with undelivered notifications.");
    await logs.flush();
    expect(sentEvents().map((e) => e.message)).toEqual(["render loop"]);
  });

  it("captures unhandled errors once", async () => {
    const logs = createSuperLogs({ endpoint: "/api/telemetry" });
    const error = new TypeError("x is undefined");
    window.dispatchEvent(new ErrorEvent("error", { error, message: error.message }));
    logs.captureException(error);
    await logs.flush();
    const events = sentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "error", event: "unhandled_error", error: { name: "TypeError", message: "x is undefined" } });
  });

  it("keeps a local page trail", async () => {
    const logs = createSuperLogs({ endpoint: "/api/telemetry" });
    history.pushState(null, "", "/somewhere-else");
    await fetch("/api/ping");
    const trail = logs.breadcrumbs();
    expect(trail.map((c) => c.type)).toEqual(["navigation", "request"]);
    expect(trail[0]!.message).toContain("/somewhere-else");
  });

  it("restores patched globals on shutdown", () => {
    const original = window.fetch;
    const logs = createSuperLogs({ endpoint: "/api/telemetry" });
    expect(window.fetch).not.toBe(original);
    logs.shutdown();
    expect(window.fetch).toBe(original);
  });
});

describe("parseUserAgent", () => {
  it("recognises common browsers and devices", () => {
    expect(parseUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0")).toEqual({
      browser: "Edge",
      browserVersion: "140.0",
      os: "Windows",
      deviceClass: "desktop",
    });
    expect(parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toMatchObject({
      browser: "Safari",
      os: "iOS",
      deviceClass: "mobile",
    });
    expect(parseUserAgent("Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36")).toMatchObject({
      os: "Android",
      deviceClass: "tablet",
    });
    expect(parseUserAgent("Googlebot/2.1 (+http://www.google.com/bot.html)").deviceClass).toBe("bot");
  });
});
