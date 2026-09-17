import type { Db } from "../db/index.js";

export interface AuditEntry {
  id: number;
  at: string;
  userId: string | null;
  actor: string | null;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
}

/** Records an administrative action. Never contains secrets. */
export function audit(
  db: Db,
  action: string,
  opts: { userId?: string | null; actor?: string | null; target?: string | null; detail?: Record<string, unknown> } = {},
): void {
  db.prepare("INSERT INTO audit_log (at, user_id, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
    new Date().toISOString(),
    opts.userId ?? null,
    opts.actor ?? null,
    action,
    opts.target ?? null,
    opts.detail ? JSON.stringify(opts.detail) : null,
  );
}

export function listAudit(db: Db, limit = 200, before?: number): AuditEntry[] {
  const rows = db
    .prepare(
      `SELECT id, at, user_id AS userId, actor, action, target, detail FROM audit_log
       WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
    )
    .all(before ?? null, before ?? null, limit) as unknown as (Omit<AuditEntry, "detail"> & { detail: string | null })[];
  return rows.map((row) => ({ ...row, detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : null }));
}
