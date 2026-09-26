import { Hono } from "hono/tiny";
import * as v from "../lib/validate.js";
import { clientIp, type AppEnv } from "../app.js";
import { metrics } from "../lib/metrics.js";
import { audit } from "../services/audit.js";
import {
  MIN_PASSWORD_LENGTH,
  authenticate,
  changePassword,
  createSession,
  deleteSession,
  deleteUserSessions,
} from "../services/auth.js";
import { normalizeIp, recordSelfSignal, recordSignIn } from "../services/security.js";
import { clearSessionCookie, csrf, requireUser, setSessionCookie } from "./guards.js";

const loginSchema = v.object({
  email: v.string({ trim: true, max: 320 }),
  password: v.string({ max: 1024 }),
});

const passwordSchema = v.object({
  currentPassword: v.string({ max: 1024 }),
  newPassword: v.string({ max: 1024 }),
});

export function authRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", csrf);

  app.post("/login", async (c) => {
    const { db, config, limits } = c.get("deps");
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: "invalid_request" }, 400);
    const { email, password } = parsed.value;
    const ip = clientIp(c);
    const emailKey = email.toLowerCase();
    const address = normalizeIp(ip);
    const userAgent = c.req.header("user-agent");
    const signal = (kind: "login_failed" | "rate_limited", httpStatus: number) =>
      recordSelfSignal(db, limits.securitySignals, {
        kind,
        ts: Date.now(),
        ip: address,
        route: "/api/auth/login",
        method: "POST",
        httpStatus,
        userAgent,
        account: emailKey,
      });

    if (!limits.loginByIp.peek(ip) || !limits.loginByEmail.peek(emailKey)) {
      signal("rate_limited", 429);
      c.header("retry-after", "900");
      return c.json({ error: "too_many_attempts" }, 429);
    }

    const user = await authenticate(db, email, password);
    if (!user) {
      // Only failures consume the budget.
      limits.loginByIp.take(ip);
      limits.loginByEmail.take(emailKey);
      metrics.loginFailures++;
      signal("login_failed", 401);
      audit(db, "auth.login_failed", { actor: emailKey.slice(0, 320) });
      return c.json({ error: "invalid_credentials" }, 401);
    }
    limits.loginByEmail.reset(emailKey);

    const session = createSession(db, user.id, config.sessionTtlMs, userAgent, address);
    setSessionCookie(c, session.token, session.expiresAt);
    recordSignIn(db, { ip: address, account: user.email, userAgent });
    audit(db, "auth.login", { userId: user.id, actor: user.email });
    return c.json({ user });
  });

  app.post("/logout", requireUser, (c) => {
    const { db } = c.get("deps");
    deleteSession(db, c.get("sessionHash"));
    clearSessionCookie(c);
    audit(db, "auth.logout", { userId: c.get("user").id, actor: c.get("user").email });
    return c.json({ ok: true });
  });

  app.get("/me", requireUser, (c) => c.json({ user: c.get("user") }));

  app.post("/password", requireUser, async (c) => {
    const { db, limits } = c.get("deps");
    const user = c.get("user");
    const parsed = passwordSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: "invalid_request" }, 400);
    if (!limits.loginByEmail.peek(user.email)) return c.json({ error: "too_many_attempts" }, 429);

    const result = await changePassword(db, user.id, parsed.value.currentPassword, parsed.value.newPassword);
    if (result === "wrong-password") {
      limits.loginByEmail.take(user.email);
      return c.json({ error: "wrong_password" }, 400);
    }
    if (result === "too-short") return c.json({ error: "password_too_short", minLength: MIN_PASSWORD_LENGTH }, 400);
    if (result === "same") return c.json({ error: "password_unchanged" }, 400);

    // Every other session of this user is signed out.
    deleteUserSessions(db, user.id, c.get("sessionHash"));
    audit(db, "auth.password_changed", { userId: user.id, actor: user.email });
    return c.json({ ok: true });
  });

  return app;
}
