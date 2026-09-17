import {
  LIMITS,
  REQUEST_ID_PATTERN,
  isLevel,
  truncate,
  type ClientInfo,
  type Level,
  type SuperLogsEvent,
} from "@super-logs/shared";
import type { SuperLogs } from "./logger.js";

/**
 * The browser never holds an ingest key. Instead the app exposes a same-origin
 * route (e.g. `/api/telemetry`) whose handler is this relay: it checks the
 * origin, rate-limits per client, keeps only known fields, stamps what the
 * server knows (user, environment, tags) and forwards through the server SDK.
 */
export interface BrowserRelayOptions {
  /** `service` for browser events. Default `<server service>-web`. */
  service?: string;
  /** Allowed `Origin`s. Default: only the request's own host. */
  allowedOrigins?: string[];
  /** Events per client per minute. Default 120. */
  eventsPerMinute?: number;
  /** Max events per request. Default 50. */
  maxEventsPerRequest?: number;
  /** Highest level a browser may claim. Default `error`. */
  maxLevel?: Level;
  /**
   * Server-side enrichment: the signed-in user's opaque id and any tags. The
   * browser is never trusted to say who the user is.
   */
  enrich?: (request: Request) => Promise<{ userId?: string; tags?: Record<string, string> } | undefined> | { userId?: string; tags?: Record<string, string> } | undefined;
}

const LEVEL_ORDER: Level[] = ["debug", "info", "warning", "error", "critical"];
const MAX_BODY = 256 * 1024;

export function createBrowserRelay(logger: SuperLogs, options: BrowserRelayOptions = {}) {
  const perMinute = options.eventsPerMinute ?? 120;
  const maxEvents = options.maxEventsPerRequest ?? 50;
  const maxLevelIndex = LEVEL_ORDER.indexOf(options.maxLevel ?? "error");
  const service = options.service ?? `${logger.service}-web`;
  const buckets = new Map<string, { tokens: number; at: number }>();

  const take = (client: string, count: number): number => {
    const now = Date.now();
    if (buckets.size > 10_000) buckets.clear(); // bounded memory under abuse
    const bucket = buckets.get(client) ?? { tokens: perMinute, at: now };
    bucket.tokens = Math.min(perMinute, bucket.tokens + ((now - bucket.at) / 60_000) * perMinute);
    bucket.at = now;
    const granted = Math.max(0, Math.min(count, Math.floor(bucket.tokens)));
    bucket.tokens -= granted;
    buckets.set(client, bucket);
    return granted;
  };

  return async function relay(request: Request): Promise<Response> {
    if (request.method !== "POST") return empty(405);
    if (!originAllowed(request, options.allowedOrigins)) return empty(403);
    // Disabled SDK: accept and discard, so the browser does not retry.
    if (!logger.enabled) return empty(204);

    const text = await readLimited(request, MAX_BODY);
    if (text === null) return empty(413);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return empty(400);
    }
    const raw = (payload as { events?: unknown })?.events;
    if (!Array.isArray(raw)) return empty(400);

    const client = clientKey(request);
    const granted = take(client, Math.min(raw.length, maxEvents));
    if (granted === 0) return empty(429);

    let extra: Awaited<ReturnType<NonNullable<BrowserRelayOptions["enrich"]>>>;
    try {
      extra = await options.enrich?.(request);
    } catch {
      extra = undefined;
    }

    for (const item of raw.slice(0, granted)) {
      const event = sanitize(item, maxLevelIndex);
      if (!event) continue;
      logger.forward({
        ...event,
        service,
        environment: logger.environment,
        userId: extra?.userId,
        tags: { ...event.tags, ...extra?.tags },
      });
    }
    return empty(204);
  };
}

function empty(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

function originAllowed(request: Request, allowed?: string[]): boolean {
  const origin = request.headers.get("origin");
  // `sendBeacon` from the same page may omit Origin on some browsers; fall back to Sec-Fetch-Site.
  if (!origin) return request.headers.get("sec-fetch-site") === "same-origin";
  if (allowed?.length) return allowed.includes(origin);
  try {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
    return new URL(origin).host === host.split(",")[0]!.trim();
  } catch {
    return false;
  }
}

/** Used only as a rate-limit bucket key; never stored or forwarded. */
function clientKey(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

async function readLimited(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const str = (value: unknown, max: number = LIMITS.maxShortField): string | undefined =>
  typeof value === "string" && value.length ? truncate(value, max) : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function sanitize(input: unknown, maxLevelIndex: number): SuperLogsEvent | null {
  if (typeof input !== "object" || input === null) return null;
  const e = input as Record<string, unknown>;
  if (!isLevel(e.level)) return null;
  const message = str(e.message, LIMITS.maxMessageLength);
  if (!message) return null;
  const level = LEVEL_ORDER[Math.min(LEVEL_ORDER.indexOf(e.level), maxLevelIndex)]!;

  const out: SuperLogsEvent = { level, message };
  const timestamp = str(e.timestamp, 40);
  if (timestamp && !Number.isNaN(Date.parse(timestamp))) out.timestamp = timestamp;
  out.event = str(e.event);
  out.release = str(e.release);
  const requestId = str(e.requestId);
  if (requestId && REQUEST_ID_PATTERN.test(requestId)) out.requestId = requestId;
  const sessionId = str(e.sessionId);
  if (sessionId && REQUEST_ID_PATTERN.test(sessionId)) out.sessionId = sessionId;
  out.route = str(e.route)?.split(/[?#]/)[0];
  out.method = str(e.method, 10);
  out.httpStatus = num(e.httpStatus);
  out.durationMs = num(e.durationMs);

  if (typeof e.error === "object" && e.error !== null) {
    const err = e.error as Record<string, unknown>;
    out.error = {
      name: str(err.name),
      message: str(err.message, LIMITS.maxMessageLength),
      stack: str(err.stack, LIMITS.maxStackLength),
      componentStack: str(err.componentStack, LIMITS.maxStackLength),
    };
  }
  if (typeof e.client === "object" && e.client !== null) {
    const c = e.client as Record<string, unknown>;
    const client: ClientInfo = {
      browser: str(c.browser, 40),
      browserVersion: str(c.browserVersion, 20),
      os: str(c.os, 40),
      viewport: str(c.viewport, 20),
      screen: str(c.screen, 20),
      language: str(c.language, 20),
      userAgent: str(c.userAgent, 300),
    };
    const deviceClass = c.deviceClass;
    if (deviceClass === "desktop" || deviceClass === "mobile" || deviceClass === "tablet" || deviceClass === "bot") {
      client.deviceClass = deviceClass;
    }
    out.client = client;
  }
  if (typeof e.tags === "object" && e.tags !== null) {
    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(e.tags).slice(0, LIMITS.maxTags)) {
      const v = str(value);
      if (v && /^[\w.:-]{1,50}$/.test(key)) tags[key] = v;
    }
    out.tags = tags;
  }
  if (typeof e.metadata === "object" && e.metadata !== null && !Array.isArray(e.metadata)) {
    const json = JSON.stringify(e.metadata);
    out.metadata =
      json.length <= LIMITS.maxMetadataBytes ? (e.metadata as Record<string, unknown>) : { truncated: true };
  }
  return out;
}
