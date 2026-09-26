import { Hono } from "hono/tiny";
import type { Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { log } from "./lib/log.js";
import { proxyObservation } from "./lib/metrics.js";
import { RateLimiter } from "./lib/rate-limit.js";
import type { User } from "./services/auth.js";
import { KeyResolver } from "./services/projects.js";
import { authRoutes } from "./routes/auth.js";
import { ingestRoutes } from "./routes/ingest.js";
import { apiRoutes } from "./routes/api.js";
import { securityRoutes } from "./routes/security.js";
import { mountDashboard } from "./routes/dashboard.js";

export interface AppDeps {
  db: Db;
  config: Config;
  keys: KeyResolver;
  limits: {
    ingest: RateLimiter;
    loginByIp: RateLimiter;
    loginByEmail: RateLimiter;
    /** Caps the security signals Super-Logs records about one address, so a flood cannot grow the table without bound. */
    securitySignals: RateLimiter;
  };
  /** Resolves the client address from the raw connection (not available in tests). */
  remoteAddress?: (c: Context) => string | undefined;
}

export type AppEnv = {
  Variables: {
    deps: AppDeps;
    user: User;
    sessionHash: string;
  };
};

export function createDeps(db: Db, config: Config, remoteAddress?: AppDeps["remoteAddress"]): AppDeps {
  return {
    db,
    config,
    keys: new KeyResolver(db),
    limits: {
      ingest: new RateLimiter(config.ingestEventsPerMinute, 60_000),
      // 10 attempts per 15 minutes from one address, 5 per 15 minutes per account.
      loginByIp: new RateLimiter(10, 15 * 60_000),
      loginByEmail: new RateLimiter(5, 15 * 60_000),
      securitySignals: new RateLimiter(60, 60_000),
    },
    remoteAddress,
  };
}

/**
 * The client address, for rate limiting and security signals (the only place
 * it is stored). Also notes how addresses arrive, for the posture checks: a
 * forwarding header from a public socket address may be spoofed, and one that
 * is ignored makes every visitor look like the proxy.
 */
export function clientIp(c: Context<AppEnv>): string {
  const { config, remoteAddress } = c.get("deps");
  const forwarded =
    c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip");
  const remote = remoteAddress?.(c);
  if (forwarded && !config.trustProxy) proxyObservation.ignoredHeaderAt = Date.now();
  if (forwarded && config.trustProxy) {
    if (remote && !isPrivateAddress(remote)) {
      proxyObservation.publicSourceAt = Date.now();
      proxyObservation.publicSource = remote;
    }
    return forwarded;
  }
  return remote ?? "unknown";
}

/** Loopback, RFC 1918, CGNAT, link-local and unique-local ranges: where a same-host or same-network proxy connects from. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, "");
  if (ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:")) return true;
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      strictTransportSecurity: deps.config.secureCookies ? "max-age=31536000; includeSubDomains" : false,
      referrerPolicy: "same-origin",
      xFrameOptions: "DENY",
      crossOriginResourcePolicy: "same-origin",
    }),
  );

  app.use("/api/*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });

  app.get("/api/health", (c) => {
    try {
      deps.db.prepare("SELECT 1").get();
      return c.json({ status: "ok", uptime: Math.round(process.uptime()) });
    } catch {
      return c.json({ status: "unhealthy", uptime: Math.round(process.uptime()) }, 503);
    }
  });

  app.route("/api/ingest", ingestRoutes());
  app.route("/api/auth", authRoutes());
  app.route("/api/security", securityRoutes());
  app.route("/api", apiRoutes());

  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

  app.onError((error, c) => {
    log.error("request failed", { error, method: c.req.method, path: c.req.path });
    return c.json({ error: "internal_error" }, 500);
  });

  mountDashboard(app, deps.config.dashboardDir);
  return app;
}
