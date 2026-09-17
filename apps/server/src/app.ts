import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { log } from "./lib/log.js";
import { RateLimiter } from "./lib/rate-limit.js";
import type { User } from "./services/auth.js";
import { KeyResolver } from "./services/projects.js";
import { authRoutes } from "./routes/auth.js";
import { ingestRoutes } from "./routes/ingest.js";
import { apiRoutes } from "./routes/api.js";
import { mountDashboard } from "./routes/dashboard.js";

export interface AppDeps {
  db: Db;
  config: Config;
  keys: KeyResolver;
  limits: {
    ingest: RateLimiter;
    loginByIp: RateLimiter;
    loginByEmail: RateLimiter;
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
    },
    remoteAddress,
  };
}

/** The client address, for rate limiting and never stored. */
export function clientIp(c: Context<AppEnv>): string {
  const { config, remoteAddress } = c.get("deps");
  if (config.trustProxy) {
    const forwarded =
      c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip");
    if (forwarded) return forwarded;
  }
  return remoteAddress?.(c) ?? "unknown";
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
  app.route("/api", apiRoutes());

  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

  app.onError((error, c) => {
    log.error("request failed", { error, method: c.req.method, path: c.req.path });
    return c.json({ error: "internal_error" }, 500);
  });

  mountDashboard(app, deps.config.dashboardDir);
  return app;
}
