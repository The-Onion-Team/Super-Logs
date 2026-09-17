/**
 * Append-only list of schema migrations. Never edit a shipped entry; add a
 * new one. Times are epoch milliseconds (INTEGER) where they are queried by
 * range, ISO text where they are only displayed.
 */
export const MIGRATIONS: string[] = [
  /* 1 — projects, keys, events, users, sessions, audit */ `
  CREATE TABLE projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE api_keys (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    prefix        TEXT NOT NULL,
    key_hash      TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT,
    revoked_at    TEXT
  );
  CREATE INDEX api_keys_project ON api_keys(project_id);

  CREATE TABLE events (
    id            INTEGER PRIMARY KEY,
    project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    ts            INTEGER NOT NULL,
    received_at   INTEGER NOT NULL,
    level         INTEGER NOT NULL,
    service       TEXT,
    environment   TEXT,
    release       TEXT,
    host          TEXT,
    event         TEXT,
    message       TEXT NOT NULL,
    request_id    TEXT,
    session_id    TEXT,
    user_id       TEXT,
    route         TEXT,
    method        TEXT,
    http_status   INTEGER,
    duration_ms   REAL,
    error_name    TEXT,
    error_message TEXT,
    error_stack   TEXT,
    fingerprint   TEXT,
    client        TEXT,
    tags          TEXT,
    metadata      TEXT
  );
  CREATE INDEX events_project_ts ON events(project_id, ts DESC, id DESC);
  CREATE INDEX events_project_level_ts ON events(project_id, level, ts DESC);
  CREATE INDEX events_project_service_ts ON events(project_id, service, ts DESC);
  CREATE INDEX events_request ON events(project_id, request_id) WHERE request_id IS NOT NULL;
  CREATE INDEX events_session ON events(project_id, session_id) WHERE session_id IS NOT NULL;
  CREATE INDEX events_user ON events(project_id, user_id) WHERE user_id IS NOT NULL;
  CREATE INDEX events_fingerprint ON events(project_id, fingerprint, ts DESC) WHERE fingerprint IS NOT NULL;
  CREATE INDEX events_received ON events(received_at);

  CREATE VIRTUAL TABLE events_fts USING fts5(
    message, error_message, event,
    content = 'events', content_rowid = 'id', tokenize = 'unicode61'
  );
  CREATE TRIGGER events_fts_insert AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, message, error_message, event)
    VALUES (new.id, new.message, new.error_message, new.event);
  END;
  CREATE TRIGGER events_fts_delete AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, message, error_message, event)
    VALUES ('delete', old.id, old.message, old.error_message, old.event);
  END;

  CREATE TABLE users (
    id                    TEXT PRIMARY KEY,
    email                 TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash         TEXT NOT NULL,
    role                  TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
    must_change_password  INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT NOT NULL,
    last_login_at         TEXT
  );

  CREATE TABLE sessions (
    token_hash    TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    user_agent    TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_expires ON sessions(expires_at);

  CREATE TABLE audit_log (
    id        INTEGER PRIMARY KEY,
    at        TEXT NOT NULL,
    user_id   TEXT,
    actor     TEXT,
    action    TEXT NOT NULL,
    target    TEXT,
    detail    TEXT
  );
  CREATE INDEX audit_log_at ON audit_log(at DESC);
  `,
];
