import type { Db } from "../db/index.js";
import { newApiKey, newId, sha256 } from "../lib/crypto.js";

export interface Project {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export interface ApiKeyInfo {
  id: string;
  projectId: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project"
  );
}

export function listProjects(db: Db): Project[] {
  return db
    .prepare("SELECT id, name, slug, created_at AS createdAt FROM projects ORDER BY created_at")
    .all() as unknown as Project[];
}

export function getProject(db: Db, id: string): Project | null {
  return (
    (db.prepare("SELECT id, name, slug, created_at AS createdAt FROM projects WHERE id = ?").get(id) as unknown as
      | Project
      | undefined) ?? null
  );
}

export function createProject(db: Db, name: string): Project {
  const base = slugify(name);
  let slug = base;
  for (let n = 2; db.prepare("SELECT 1 FROM projects WHERE slug = ?").get(slug); n++) slug = `${base}-${n}`;
  const project: Project = { id: newId("prj"), name: name.trim(), slug, createdAt: new Date().toISOString() };
  db.prepare("INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)").run(
    project.id,
    project.name,
    project.slug,
    project.createdAt,
  );
  return project;
}

export function renameProject(db: Db, id: string, name: string): boolean {
  return Number(db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name.trim(), id).changes) > 0;
}

/** Deletes a project and, by cascade, its keys and events. */
export function deleteProject(db: Db, id: string): boolean {
  return Number(db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes) > 0;
}

const KEY_COLUMNS =
  "id, project_id AS projectId, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt, revoked_at AS revokedAt";

export function listKeys(db: Db, projectId: string): ApiKeyInfo[] {
  return db
    .prepare(`SELECT ${KEY_COLUMNS} FROM api_keys WHERE project_id = ? ORDER BY created_at DESC`)
    .all(projectId) as unknown as ApiKeyInfo[];
}

/** Creates a key. The secret is returned exactly once; only its hash is stored. */
export function createKey(db: Db, projectId: string, name: string): { key: ApiKeyInfo; secret: string } {
  const secret = newApiKey();
  const key: ApiKeyInfo = {
    id: newId("key"),
    projectId,
    name: name.trim(),
    prefix: secret.slice(0, 10),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  };
  db.prepare(
    "INSERT INTO api_keys (id, project_id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(key.id, projectId, key.name, key.prefix, sha256(secret), key.createdAt);
  return { key, secret };
}

export function revokeKey(db: Db, projectId: string, keyId: string): boolean {
  const result = db
    .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), keyId, projectId);
  return Number(result.changes) > 0;
}

export interface KeyLookup {
  keyId: string;
  projectId: string;
}

/**
 * Resolves ingest keys with a short cache, so a busy producer does not cost a
 * query per request. Revocation clears the cache immediately in this process.
 */
export class KeyResolver {
  private readonly cache = new Map<string, { value: KeyLookup | null; until: number }>();
  private readonly lastTouched = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 60_000,
  ) {}

  resolve(secret: string, now = Date.now()): KeyLookup | null {
    if (!/^slk_[A-Za-z0-9]{32}$/.test(secret)) return null;
    const hash = sha256(secret);
    const cached = this.cache.get(hash);
    if (cached && cached.until > now) return cached.value;
    const row = this.db
      .prepare("SELECT id, project_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL")
      .get(hash) as { id: string; project_id: string } | undefined;
    const value = row ? { keyId: row.id, projectId: row.project_id } : null;
    if (this.cache.size > 10_000) this.cache.clear();
    // Unknown keys are cached briefly too, so a flood of bad keys stays cheap.
    this.cache.set(hash, { value, until: now + (value ? this.ttlMs : 10_000) });
    return value;
  }

  /** Records use at most once a minute per key. */
  touch(keyId: string, now = Date.now()): void {
    if ((this.lastTouched.get(keyId) ?? 0) > now - 60_000) return;
    this.lastTouched.set(keyId, now);
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date(now).toISOString(), keyId);
  }

  invalidate(): void {
    this.cache.clear();
  }
}
