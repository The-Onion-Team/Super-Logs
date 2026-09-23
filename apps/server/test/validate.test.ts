/**
 * These cases were derived by running the schemas against zod on the same
 * inputs before zod was removed, and keeping the boundaries it enforced.
 * They are the safety net for the hand-written validators in `lib/validate.ts`.
 */
import { describe, expect, it } from "vitest";
import { LIMITS } from "@super-logs/shared";
import { batchSchema, eventQuerySchema, eventSchema } from "../src/services/events.js";
import { loadConfig } from "../src/config.js";
import * as v from "../src/lib/validate.js";

const long = (n: number) => "x".repeat(n);
const accepts = (input: unknown) => eventSchema.safeParse(input).ok;

describe("event validation", () => {
  it("accepts a minimal event and rejects a malformed one", () => {
    expect(accepts({ level: "error", message: "ok" })).toBe(true);
    expect(accepts({ level: "loud", message: "bad level" })).toBe(false);
    expect(accepts({ level: "info", message: "" })).toBe(false);
    expect(accepts({ level: "info" })).toBe(false);
    expect(accepts({ message: "no level" })).toBe(false);
    expect(accepts({ level: "info", message: 42 })).toBe(false);
  });

  it("rejects anything that is not an object", () => {
    for (const input of ["a string", null, undefined, [], 42]) expect(accepts(input)).toBe(false);
  });

  it("enforces the message and stack ceilings exactly", () => {
    expect(accepts({ level: "info", message: long(LIMITS.maxMessageLength * 10) })).toBe(true);
    expect(accepts({ level: "info", message: long(LIMITS.maxMessageLength * 10 + 1) })).toBe(false);
    expect(accepts({ level: "info", message: "m", error: { stack: long(LIMITS.maxStackLength * 4 + 1) } })).toBe(false);
  });

  it("only accepts correlation ids in the agreed alphabet", () => {
    expect(accepts({ level: "info", message: "m", requestId: "req_12345678" })).toBe(true);
    expect(accepts({ level: "info", message: "m", requestId: "short" })).toBe(false);
    expect(accepts({ level: "info", message: "m", requestId: "bad id with spaces!!" })).toBe(false);
    expect(accepts({ level: "info", message: "m", sessionId: "a".repeat(129) })).toBe(false);
  });

  it("bounds the numeric fields", () => {
    expect(accepts({ level: "info", message: "m", httpStatus: 1000 })).toBe(false);
    expect(accepts({ level: "info", message: "m", httpStatus: 200.5 })).toBe(false);
    expect(accepts({ level: "info", message: "m", httpStatus: -1 })).toBe(false);
    // A numeric string is not a number here: only queries and the environment coerce.
    expect(accepts({ level: "info", message: "m", httpStatus: "500" })).toBe(false);
    expect(accepts({ level: "info", message: "m", durationMs: -1 })).toBe(false);
    expect(accepts({ level: "info", message: "m", durationMs: 1.5 })).toBe(true);
  });

  it("truncates over-long short fields instead of rejecting them", () => {
    const parsed = eventSchema.safeParse({ level: "info", message: "m", service: `  ${long(700)}  ` });
    expect(parsed.ok && parsed.value.service).toHaveLength(LIMITS.maxShortField);
    // Past four times the limit it is no longer a stray long value, it is junk.
    expect(accepts({ level: "info", message: "m", service: long(LIMITS.maxShortField * 4 + 1) })).toBe(false);
  });

  it("polices tag keys, tag values and the tag count", () => {
    expect(accepts({ level: "info", message: "m", tags: { ok: "1" } })).toBe(true);
    expect(accepts({ level: "info", message: "m", tags: { "bad key!": "1" } })).toBe(false);
    expect(accepts({ level: "info", message: "m", tags: { "": "1" } })).toBe(false);
    expect(accepts({ level: "info", message: "m", tags: { k: long(LIMITS.maxShortField + 1) } })).toBe(false);
    expect(accepts({ level: "info", message: "m", tags: [] })).toBe(false);
    const tags = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, "v"]));
    expect(accepts({ level: "info", message: "m", tags: tags(LIMITS.maxTags) })).toBe(true);
    expect(accepts({ level: "info", message: "m", tags: tags(LIMITS.maxTags + 1) })).toBe(false);
  });

  it("drops unknown keys rather than failing", () => {
    const parsed = eventSchema.safeParse({ level: "critical", message: "m", nonsense: "dropped" });
    expect(parsed.ok && "nonsense" in parsed.value).toBe(false);
  });

  it("names the offending field in the message", () => {
    const parsed = eventSchema.safeParse({ level: "info", message: "m", error: { stack: 5 } });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.issues[0]).toMatchObject({ path: "error.stack", message: "must be a string" });
  });
});

describe("query and batch validation", () => {
  it("coerces limit from a query string, within bounds", () => {
    expect(eventQuerySchema.safeParse({ limit: "50" })).toMatchObject({ ok: true, value: { limit: 50 } });
    expect(eventQuerySchema.safeParse({})).toMatchObject({ ok: true, value: { limit: 100 } });
    for (const limit of ["0", "501", "abc", "", "1.5"]) expect(eventQuerySchema.safeParse({ limit }).ok).toBe(false);
  });

  it("requires tag and cursor to be well formed", () => {
    expect(eventQuerySchema.safeParse({ tag: "a:b" }).ok).toBe(true);
    expect(eventQuerySchema.safeParse({ tag: "bad" }).ok).toBe(false);
    expect(eventQuerySchema.safeParse({ cursor: "1:2" }).ok).toBe(true);
    expect(eventQuerySchema.safeParse({ cursor: "x" }).ok).toBe(false);
  });

  it("requires between one and the maximum number of events", () => {
    expect(batchSchema.safeParse({ events: [{}] }).ok).toBe(true);
    expect(batchSchema.safeParse({ events: [] }).ok).toBe(false);
    expect(batchSchema.safeParse({ events: "x" }).ok).toBe(false);
    expect(batchSchema.safeParse({}).ok).toBe(false);
    expect(batchSchema.safeParse({ events: Array.from({ length: LIMITS.maxEventsPerBatch }, () => ({})) }).ok).toBe(true);
    expect(batchSchema.safeParse({ events: Array.from({ length: LIMITS.maxEventsPerBatch + 1 }, () => ({})) }).ok).toBe(false);
  });
});

describe("configuration validation", () => {
  const bad = (env: Record<string, string>) => expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(/Invalid Super-Logs configuration/);

  it("rejects values outside their range", () => {
    bad({ SUPER_LOGS_PORT: "70000" });
    bad({ SUPER_LOGS_PORT: "abc" });
    bad({ SUPER_LOGS_RETENTION_DAYS: "0" });
    bad({ SUPER_LOGS_RETENTION_DAYS: "3651" });
    bad({ SUPER_LOGS_LOG_LEVEL: "verbose" });
    bad({ SUPER_LOGS_TRUST_PROXY: "maybe" });
    bad({ SUPER_LOGS_ADMIN_EMAIL: "nope" });
    bad({ SUPER_LOGS_ADMIN_PASSWORD: "short" });
  });

  it("requires a real http(s) URL for the dashboard, not merely a parseable one", () => {
    bad({ SUPER_LOGS_PUBLIC_URL: "not a url" });
    bad({ SUPER_LOGS_PUBLIC_URL: "mailto:someone@example.com" });
    expect(loadConfig({ SUPER_LOGS_PUBLIC_URL: "https://x.com" } as NodeJS.ProcessEnv).publicOrigin).toBe("https://x.com");
  });

  it("defaults the Telegram API host but allows a mirror", () => {
    const base = (env: Record<string, string>) =>
      loadConfig({
        SUPER_LOGS_TELEGRAM_BOT_TOKEN: "123456789:AAFakeTokenForTestsOnly-0123456789",
        SUPER_LOGS_TELEGRAM_CHAT_ID: "-100123",
        ...env,
      } as NodeJS.ProcessEnv).telegram?.apiBaseUrl;
    expect(base({})).toBe("https://api.telegram.org");
    expect(base({ SUPER_LOGS_TELEGRAM_API_BASE_URL: "https://tg.example.com" })).toBe("https://tg.example.com");
    bad({ SUPER_LOGS_TELEGRAM_API_BASE_URL: "not a url" });
  });

  it("reports every problem at once, so one restart fixes them all", () => {
    try {
      loadConfig({ SUPER_LOGS_PORT: "abc", SUPER_LOGS_LOG_LEVEL: "verbose" } as NodeJS.ProcessEnv);
      throw new Error("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("SUPER_LOGS_PORT");
      expect(message).toContain("SUPER_LOGS_LOG_LEVEL");
    }
  });
});

describe("validator building blocks", () => {
  it("treats absent and null differently, as JSON callers do", () => {
    const check = v.optional(v.string());
    expect(check.safeParse(undefined)).toEqual({ ok: true, value: undefined });
    expect(check.safeParse(null).ok).toBe(false);
  });

  it("only applies a default to an absent value", () => {
    const check = v.withDefault(v.number({ coerce: true }), 7);
    expect(check.safeParse(undefined)).toEqual({ ok: true, value: 7 });
    expect(check.safeParse("3")).toEqual({ ok: true, value: 3 });
    expect(check.safeParse("").ok).toBe(false);
  });

  it("reports a nested path", () => {
    const check = v.object({ outer: v.object({ inner: v.string() }) });
    const parsed = check.safeParse({ outer: { inner: 1 } });
    expect(!parsed.ok && parsed.issues[0]?.path).toBe("outer.inner");
  });

  it("rejects arrays where an object is required", () => {
    expect(v.object({}).safeParse([]).ok).toBe(false);
    expect(v.record(v.string(), v.string()).safeParse([]).ok).toBe(false);
  });
});
