import { describe, expect, it } from "vitest";
import {
  REDACTED,
  fingerprint,
  normalizeMessage,
  normalizeRoute,
  redact,
  redactEvent,
  redactString,
  stackSignature,
} from "@super-logs/shared";

describe("redact", () => {
  it("drops sensitive keys at any depth", () => {
    const out = redact({
      user: { password: "hunter2", apiKey: "abc", "x-api-key": "abc", refreshToken: "t", sessionId: "sess_1" },
      headers: { Authorization: "Bearer abcdefghijkl", cookie: "a=b" },
      list: [{ secret: 1 }],
    }) as Record<string, any>;
    expect(out.user.password).toBe(REDACTED);
    expect(out.user.apiKey).toBe(REDACTED);
    expect(out.user["x-api-key"]).toBe(REDACTED);
    expect(out.user.refreshToken).toBe(REDACTED);
    expect(out.user.sessionId).toBe("sess_1");
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers.cookie).toBe(REDACTED);
    expect(out.list[0].secret).toBe(REDACTED);
  });

  it("redacts credential-shaped values under innocent keys", () => {
    expect(redactString("call failed with Bearer abc.def.ghijklmnop")).toBe(`call failed with Bearer ${REDACTED}`);
    expect(redactString("key slk_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 leaked")).toBe(`key ${REDACTED} leaked`);
    expect(redactString("GET /reset?token=abc123&x=1")).toBe(`GET /reset?token=${REDACTED}&x=1`);
    expect(redactString("card 4242 4242 4242 4242 declined")).toBe(`card ${REDACTED} declined`);
  });

  it("keeps numbers that only look like cards", () => {
    expect(redactString("took 1726570000000 ms")).toBe("took 1726570000000 ms");
  });

  it("survives cycles, errors and exotic values", () => {
    const a: Record<string, unknown> = { n: 1n, f: () => 1, d: new Date(0), s: new Set([1]), m: new Map([["k", "v"]]) };
    a.self = a;
    const out = redact({ a, e: new Error("boom") }) as Record<string, any>;
    expect(out.a.self).toBe("[Circular]");
    expect(out.a.n).toBe("1");
    expect(out.a.f).toBeUndefined();
    expect(out.a.d).toBe("1970-01-01T00:00:00.000Z");
    expect(out.a.s).toEqual([1]);
    expect(out.a.m).toEqual({ k: "v" });
    expect(out.e.message).toBe("boom");
  });

  it("redacts event message, error and metadata", () => {
    const event = redactEvent({
      message: "auth with Bearer 1234567890abcdef",
      error: { message: "token=abc", stack: "at x?password=pw" },
      metadata: { password: "x" },
    });
    expect(event.message).toContain(REDACTED);
    expect(event.metadata).toEqual({ password: REDACTED });
    expect(event.error?.stack).toContain(REDACTED);
  });
});

describe("fingerprint", () => {
  it("normalises variable parts of messages", () => {
    expect(normalizeMessage("User 42 not found (id 550e8400-e29b-41d4-a716-446655440000) at 2026-09-17T10:30:00Z")).toBe(
      "User <n> not found (id <uuid>) at <date>",
    );
    expect(normalizeMessage('League "alpha" missing for mario@example.com')).toBe("League <str> missing for <email>");
  });

  it("normalises numbers that carry a unit, so timings do not fragment groups", () => {
    // A digit followed by a letter has no word boundary between them, so these
    // used to survive and give every occurrence its own fingerprint.
    expect(normalizeMessage("no response after 245ms")).toBe("no response after <n>");
    expect(normalizeMessage("payload 512kb exceeds the limit")).toBe("payload <n> exceeds the limit");
    expect(normalizeMessage("retry in 5s")).toBe("retry in <n>");
    expect(fingerprint({ message: "no response after 245ms" })).toBe(fingerprint({ message: "no response after 1980ms" }));
    // Identifiers whose digits follow letters are left alone.
    expect(normalizeMessage("sha256 mismatch in utf8 payload")).toBe("sha256 mismatch in utf8 payload");
  });

  it("normalises route ids", () => {
    expect(normalizeRoute("/league/42/team/cm1abcdefghijklmnopqrstu?tab=1")).toBe("/league/:n/team/:id");
  });

  it("ignores line numbers and bundle hashes in stacks", () => {
    const a = "Error: x\n    at load (/app/.next/server/chunks/page-3f2a9b1c7d.js:10:5)\n    at node:internal/foo:1:1";
    const b = "Error: x\n    at load (/app/.next/server/chunks/page-99aa88bb77.js:99:1)";
    expect(stackSignature(a)).toBe(stackSignature(b));
  });

  it("groups the same problem and separates different ones", () => {
    const base = { service: "api", message: "x", error: { name: "DbError", message: "Row 12 locked", stack: "DbError\n    at q (/app/db.ts:1:1)" } };
    const same = { ...base, error: { ...base.error, message: "Row 99 locked", stack: "DbError\n    at q (/app/db.ts:7:3)" } };
    const other = { ...base, error: { ...base.error, name: "TimeoutError" } };
    expect(fingerprint(base)).toBe(fingerprint(same));
    expect(fingerprint(base)).not.toBe(fingerprint(other));
    expect(fingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
  });
});
