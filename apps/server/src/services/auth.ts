import type { Db } from "../db/index.js";
import { DUMMY_PASSWORD_HASH, hashPassword, newId, randomToken, sha256, verifyPassword } from "../lib/crypto.js";

export type Role = "admin" | "viewer";

export interface User {
  id: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  must_change_password: number;
  created_at: string;
  last_login_at: string | null;
}

export const MIN_PASSWORD_LENGTH = 12;

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export function countUsers(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}

export async function createUser(
  db: Db,
  input: { email: string; password: string; role: Role; mustChangePassword?: boolean },
): Promise<User> {
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  const row: UserRow = {
    id: newId("usr"),
    email: input.email.trim().toLowerCase(),
    password_hash: await hashPassword(input.password),
    role: input.role,
    must_change_password: input.mustChangePassword ? 1 : 0,
    created_at: new Date().toISOString(),
    last_login_at: null,
  };
  db.prepare(
    "INSERT INTO users (id, email, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.email, row.password_hash, row.role, row.must_change_password, row.created_at);
  return toUser(row);
}

/** First boot: creates the administrator from the environment when no user exists yet. */
export async function ensureAdmin(db: Db, admin: { email: string; password: string } | undefined): Promise<User | null> {
  if (countUsers(db) > 0 || !admin) return null;
  // The environment password is a bootstrap secret: it must be replaced at first sign-in.
  return createUser(db, { ...admin, role: "admin", mustChangePassword: true });
}

/** Checks credentials in constant-ish time whether or not the account exists. */
export async function authenticate(db: Db, email: string, password: string): Promise<User | null> {
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) as UserRow | undefined;
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || !ok) return null;
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  return toUser(row);
}

export async function changePassword(db: Db, userId: string, current: string, next: string): Promise<"ok" | "wrong-password" | "too-short" | "same"> {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
  if (!row || !(await verifyPassword(current, row.password_hash))) return "wrong-password";
  if (next.length < MIN_PASSWORD_LENGTH) return "too-short";
  if (current === next) return "same";
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(await hashPassword(next), userId);
  return "ok";
}

// --- sessions --------------------------------------------------------------

export function createSession(db: Db, userId: string, ttlMs: number, userAgent: string | undefined): { token: string; expiresAt: number } {
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + ttlMs;
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(sha256(token), userId, now, expiresAt, now, userAgent?.slice(0, 300) ?? null);
  return { token, expiresAt };
}

/**
 * Resolves a session cookie. Sessions slide: each use (at most every five
 * minutes) pushes the expiry forward by the full TTL.
 */
export function userFromSession(db: Db, token: string | undefined, ttlMs: number, now = Date.now()): { user: User; tokenHash: string; expiresAt: number } | null {
  if (!token || token.length > 100) return null;
  const tokenHash = sha256(token);
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at AS s_expires, s.last_seen_at AS s_seen
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as (UserRow & { s_expires: number; s_seen: number }) | undefined;
  if (!row) return null;
  if (row.s_expires <= now) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  let expiresAt = row.s_expires;
  if (now - row.s_seen > 5 * 60_000) {
    expiresAt = now + ttlMs;
    db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?").run(now, expiresAt, tokenHash);
  }
  return { user: toUser(row), tokenHash, expiresAt };
}

export function deleteSession(db: Db, tokenHash: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

/** Signs a user out everywhere except (optionally) the current session. */
export function deleteUserSessions(db: Db, userId: string, exceptTokenHash?: string): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, exceptTokenHash ?? "");
}

export function deleteExpiredSessions(db: Db, now = Date.now()): number {
  return Number(db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now).changes);
}
