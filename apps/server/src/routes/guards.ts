import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../app.js";
import { userFromSession } from "../services/auth.js";

export const SESSION_COOKIE = "sl_session";

/** Browsers send this header only when our own dashboard code asks them to. */
export const CSRF_HEADER = "x-super-logs-csrf";

export function setSessionCookie(c: Context<AppEnv>, token: string, expiresAt: number): void {
  const { config } = c.get("deps");
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "Strict",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: c.get("deps").config.secureCookies });
}

/**
 * Cross-site request protection for cookie-authenticated writes: SameSite
 * Strict cookies, plus a custom header (which a cross-site form cannot send)
 * and an Origin check.
 */
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
  const origin = c.req.header("origin");
  const { publicOrigin } = c.get("deps").config;
  if (c.req.header(CSRF_HEADER) !== "1" || (origin && origin !== publicOrigin)) {
    return c.json({ error: "csrf_rejected" }, 403);
  }
  return next();
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { db, config } = c.get("deps");
  const session = userFromSession(db, getCookie(c, SESSION_COOKIE), config.sessionTtlMs);
  if (!session) {
    clearSessionCookie(c);
    return c.json({ error: "unauthenticated" }, 401);
  }
  c.set("user", session.user);
  c.set("sessionHash", session.tokenHash);
  // A bootstrap password must be replaced before anything else is reachable.
  if (session.user.mustChangePassword && !c.req.path.endsWith("/auth/password") && !c.req.path.endsWith("/auth/me") && !c.req.path.endsWith("/auth/logout")) {
    return c.json({ error: "password_change_required" }, 403);
  }
  return next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("user").role !== "admin") return c.json({ error: "forbidden" }, 403);
  return next();
};
