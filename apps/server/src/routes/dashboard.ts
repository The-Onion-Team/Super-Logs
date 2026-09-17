import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import type { AppEnv } from "../app.js";
import { log } from "../lib/log.js";

/** Serves the built dashboard (a static SPA) with index.html as the fallback route. */
export function mountDashboard(app: Hono<AppEnv>, dir: string | undefined): void {
  const index = dir ? join(dir, "index.html") : undefined;
  if (!dir || !index || !existsSync(index)) {
    if (dir) log.warning("dashboard build not found; serving the API only", { dir });
    app.get("/", (c) => c.text("Super-Logs API is running. The dashboard is not built (npm run build).", 200));
    return;
  }
  const html = readFileSync(index, "utf8");

  // Vite fingerprints everything under /assets, so it can be cached for good.
  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.ok) c.header("cache-control", "public, max-age=31536000, immutable");
  });
  app.use("/*", serveStatic({ root: dir }));
  app.get("*", (c) => {
    c.header("cache-control", "no-cache");
    return c.html(html);
  });
}
