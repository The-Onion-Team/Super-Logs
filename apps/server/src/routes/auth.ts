import { Hono } from "hono";
import { z } from "zod";
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
import { clearSessionCookie, csrf, requireUser, setSessionCookie } from "./guards.js";

const loginSchema = z.object({
  email: z.string().trim().max(320),
  password: z.string().max(1024),
});

const passwordSchema = z.object({
  currentPassword: z.string().max(1024),
  newPassword: z.string().max(1024),
});

export function authRoutes() {
  const app = new Hono<AppEnv>();
  app.use("*", csrf);

  app.post("/login", async (c) => {
    const { db, config, limits } = c.get("deps");
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    const { email, password } = parsed.data;
    const ip = clientIp(c);
    const emailKey = email.toLowerCase();

    if (!limits.loginByIp.peek(ip) || !limits.loginByEmail.peek(emailKey)) {
      c.header("retry-after", "900");
      return c.json({ error: "too_many_attempts" }, 429);
    }

    const user = await authenticate(db, email, password);
    if (!user) {
      // Only failures consume the budget.
      limits.loginByIp.take(ip);
      limits.loginByEmail.take(emailKey);
      metrics.loginFailures++;
      audit(db, "auth.login_failed", { actor: emailKey.slice(0, 320) });
      return c.json({ error: "invalid_credentials" }, 401);
    }
    limits.loginByEmail.reset(emailKey);

    const session = createSession(db, user.id, config.sessionTtlMs, c.req.header("user-agent"));
    setSessionCookie(c, session.token, session.expiresAt);
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
    if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
    if (!limits.loginByEmail.peek(user.email)) return c.json({ error: "too_many_attempts" }, 429);

    const result = await changePassword(db, user.id, parsed.data.currentPassword, parsed.data.newPassword);
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
