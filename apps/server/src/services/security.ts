/**
 * Security: signals in, findings out.
 *
 * Signals are single suspicious requests with the client address attached,
 * reported by an app's SDK (a probe for `/.env`, a 401, a failed sign-in) or
 * recorded by Super-Logs itself (a failed dashboard sign-in, a bad ingest
 * key). They are the only rows that hold an IP, and they are kept for
 * `SUPER_LOGS_SECURITY_RETENTION_DAYS` only.
 *
 * Once a minute the detection pass counts recent signals per address and
 * opens a *finding* when a rule's threshold is crossed: one open finding per
 * project, rule and address. A finding in an app project is also written into
 * that project's log as one synthetic event without the IP, so the existing
 * incident grouping, cooldown and Telegram delivery apply to it unchanged.
 * Findings about Super-Logs itself have no project and are sent directly.
 */
import { LEVEL_RANK, hash, type Level, type SuperLogsEvent } from "@super-logs/shared";
import type { Db } from "../db/index.js";
import { newId } from "../lib/crypto.js";
import { metrics } from "../lib/metrics.js";
import type { RateLimiter } from "../lib/rate-limit.js";
import type { AlertChannel, IncidentAlert } from "./alerts.js";
import { insertEvents } from "./events.js";

/** Kinds only Super-Logs records about itself, next to the shared `SecuritySignalKind`s. */
export type SelfSignalKind = "sign_in" | "login_failed" | "rate_limited" | "bad_api_key";

export interface SignalInput {
  kind: string;
  ts: number;
  ip?: string | null;
  route?: string | null;
  method?: string | null;
  httpStatus?: number | null;
  userAgent?: string | null;
  account?: string | null;
}

/** Detection looks this far back. */
export const DETECTION_WINDOW_MS = 10 * 60_000;
/** A finding with no new signal for this long is resolved. */
export const FINDING_QUIET_MS = 30 * 60_000;

export type RuleId = "brute_force" | "scanner" | "error_flood" | "dashboard_brute_force" | "key_guessing" | "new_ip_sign_in";

interface Rule {
  id: RuleId;
  /** `app`: an app project's traffic. `self`: Super-Logs' own endpoints. */
  scope: "app" | "self";
  kinds: string[];
  threshold: number;
  /** Stable text: it is also what the synthetic event's fingerprint is built from. */
  message: string;
  level: (count: number, accounts: number) => Level;
}

export const RULES: Rule[] = [
  {
    id: "brute_force",
    scope: "app",
    kinds: ["auth_failed", "login_failed"],
    threshold: 20,
    message: "Security: repeated failed sign-ins or denied requests from one address",
    // Many accounts from one address is credential stuffing, which is worse than guessing one password.
    level: (count, accounts) => (count >= 100 || accounts >= 5 ? "critical" : "warning"),
  },
  {
    id: "scanner",
    scope: "app",
    kinds: ["probe"],
    threshold: 10,
    message: "Security: one address is scanning for known weak spots (/.env, /wp-admin, …)",
    level: (count) => (count >= 100 ? "critical" : "warning"),
  },
  {
    id: "error_flood",
    scope: "app",
    kinds: ["server_error"],
    threshold: 20,
    message: "Security: one address is causing a burst of server errors",
    level: () => "warning",
  },
  {
    id: "dashboard_brute_force",
    scope: "self",
    kinds: ["login_failed", "rate_limited"],
    threshold: 5,
    message: "Security: repeated failed sign-ins to the Super-Logs dashboard",
    level: () => "critical",
  },
  {
    id: "key_guessing",
    scope: "self",
    kinds: ["bad_api_key"],
    threshold: 20,
    message: "Security: repeated requests with an invalid ingest key",
    level: () => "warning",
  },
];

const RULE_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));

export const NEW_IP_SIGN_IN_MESSAGE = "Security: dashboard sign-in from an address not seen before for this account";

// --- signals ---------------------------------------------------------------

/** Stores signals for one project (or for Super-Logs itself, with `projectId` null). */
export function recordSignals(db: Db, projectId: string | null, signals: SignalInput[]): void {
  if (!signals.length) return;
  const insert = db.prepare(
    `INSERT INTO security_signals (project_id, ts, kind, ip, route, method, http_status, user_agent, account)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of signals) {
    insert.run(
      projectId,
      s.ts,
      s.kind,
      s.ip ?? null,
      s.route?.slice(0, 200) ?? null,
      s.method?.slice(0, 16) ?? null,
      s.httpStatus ?? null,
      s.userAgent?.slice(0, 300) ?? null,
      s.account?.slice(0, 320) ?? null,
    );
  }
}

/**
 * Records a signal about Super-Logs itself. At most `limiter`'s budget per
 * address is kept: past that, an attacker is already detected and more rows
 * would only grow the table.
 */
export function recordSelfSignal(db: Db, limiter: RateLimiter, signal: SignalInput): void {
  if (signal.ip && limiter.take(signal.ip, 1, signal.ts) === 0) return;
  recordSignals(db, null, [signal]);
  metrics.securitySignals++;
}

/** `::ffff:1.2.3.4` (how Node reports IPv4 on a dual-stack socket) → `1.2.3.4`. Unknown → null. */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (!ip || ip === "unknown") return null;
  const trimmed = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
  return (mapped ? mapped[1]! : trimmed).slice(0, 45) || null;
}

/**
 * Records a successful dashboard sign-in and, when the account has signed in
 * before but never from this address, opens an informational finding. Only
 * the retention window is remembered, so "never" means "not recently".
 */
export function recordSignIn(db: Db, input: { ip: string | null; account: string; userAgent?: string | null }, now = Date.now()): boolean {
  let isNew = false;
  if (input.ip) {
    const history = db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(MAX(ip = ?), 0) AS same FROM security_signals
         WHERE project_id IS NULL AND kind = 'sign_in' AND account = ?`,
      )
      .get(input.ip, input.account) as { n: number; same: number };
    isNew = history.n > 0 && history.same === 0;
  }
  recordSignals(db, null, [{ kind: "sign_in", ts: now, ip: input.ip, userAgent: input.userAgent, account: input.account }]);
  if (isNew && input.ip) {
    upsertFinding(db, {
      projectId: null,
      rule: "new_ip_sign_in",
      ip: input.ip,
      level: "info",
      firstSeen: now,
      lastSeen: now,
      count: 1,
      detail: { account: input.account },
    });
  }
  return isNew;
}

// --- findings --------------------------------------------------------------

export interface FindingDetail {
  /** Most-hit routes, most frequent first. */
  routes?: { route: string; count: number }[];
  /** Distinct accounts tried (app rules: hashed; dashboard: as typed). */
  accounts?: number;
  account?: string;
  kinds?: Record<string, number>;
}

export interface Finding {
  id: string;
  projectId: string | null;
  projectName: string | null;
  rule: RuleId;
  message: string;
  ip: string;
  level: Level;
  status: "open" | "resolved";
  firstSeen: string;
  lastSeen: string;
  signalCount: number;
  detail: FindingDetail | null;
  lastAlertAt: string | null;
  resolvedAt: string | null;
}

interface FindingRow {
  id: string;
  project_id: string | null;
  project_name: string | null;
  rule: RuleId;
  ip: string;
  level: number;
  status: "open" | "resolved";
  first_seen_at: number;
  last_seen_at: number;
  signal_count: number;
  detail: string | null;
  last_alert_at: number | null;
  resolved_at: number | null;
}

function levelName(rank: number): Level {
  if (rank >= LEVEL_RANK.critical) return "critical";
  if (rank >= LEVEL_RANK.error) return "error";
  if (rank >= LEVEL_RANK.warning) return "warning";
  return "info";
}

function toFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    rule: row.rule,
    message: row.rule === "new_ip_sign_in" ? NEW_IP_SIGN_IN_MESSAGE : (RULE_BY_ID.get(row.rule)?.message ?? row.rule),
    ip: row.ip,
    level: levelName(row.level),
    status: row.status,
    firstSeen: new Date(row.first_seen_at).toISOString(),
    lastSeen: new Date(row.last_seen_at).toISOString(),
    signalCount: row.signal_count,
    detail: row.detail ? (JSON.parse(row.detail) as FindingDetail) : null,
    lastAlertAt: row.last_alert_at === null ? null : new Date(row.last_alert_at).toISOString(),
    resolvedAt: row.resolved_at === null ? null : new Date(row.resolved_at).toISOString(),
  };
}

const FINDING_SELECT = `SELECT f.*, p.name AS project_name FROM security_findings f LEFT JOIN projects p ON p.id = f.project_id`;

interface FindingInput {
  projectId: string | null;
  rule: RuleId;
  ip: string;
  level: Level;
  firstSeen: number;
  lastSeen: number;
  count: number;
  detail: FindingDetail;
}

/**
 * Opens a finding, or refreshes the open one for the same project, rule and
 * address. A level increase clears `last_alert_at` so the escalation is
 * alerted straight away instead of waiting out the cooldown.
 */
export function upsertFinding(db: Db, input: FindingInput): { id: string; created: boolean; escalated: boolean } {
  const rank = LEVEL_RANK[input.level];
  const open = db
    .prepare("SELECT id, level FROM security_findings WHERE COALESCE(project_id, '') = ? AND rule = ? AND ip = ? AND status = 'open'")
    .get(input.projectId ?? "", input.rule, input.ip) as { id: string; level: number } | undefined;
  if (open) {
    const escalated = rank > open.level;
    db.prepare(
      `UPDATE security_findings
       SET last_seen_at = MAX(last_seen_at, ?), signal_count = MAX(signal_count, ?), level = MAX(level, ?), detail = ?,
           last_alert_at = CASE WHEN ? THEN NULL ELSE last_alert_at END
       WHERE id = ?`,
    ).run(input.lastSeen, input.count, rank, JSON.stringify(input.detail), escalated ? 1 : 0, open.id);
    return { id: open.id, created: false, escalated };
  }
  const id = newId("sec");
  db.prepare(
    `INSERT INTO security_findings (id, project_id, rule, ip, level, status, first_seen_at, last_seen_at, signal_count, detail)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
  ).run(id, input.projectId, input.rule, input.ip, rank, input.firstSeen, input.lastSeen, input.count, JSON.stringify(input.detail));
  return { id, created: true, escalated: false };
}

export function listFindings(
  db: Db,
  query: { status: "open" | "resolved" | "all"; project?: string; limit?: number },
): Finding[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.status !== "all") {
    where.push("f.status = ?");
    params.push(query.status);
  }
  if (query.project === "self") where.push("f.project_id IS NULL");
  else if (query.project) {
    where.push("f.project_id = ?");
    params.push(query.project);
  }
  params.push(query.limit ?? 100);
  const rows = db
    .prepare(`${FINDING_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY f.status = 'open' DESC, f.level DESC, f.last_seen_at DESC LIMIT ?`)
    .all(...params) as unknown as FindingRow[];
  return rows.map(toFinding);
}

export function getFinding(db: Db, id: string): Finding | null {
  const row = db.prepare(`${FINDING_SELECT} WHERE f.id = ?`).get(id) as FindingRow | undefined;
  return row ? toFinding(row) : null;
}

export function resolveFinding(db: Db, id: string, now = Date.now()): boolean {
  const result = db.prepare("UPDATE security_findings SET status = 'resolved', resolved_at = ? WHERE id = ? AND status = 'open'").run(now, id);
  return Number(result.changes) > 0;
}

export interface SignalView {
  at: string;
  kind: string;
  ip: string | null;
  route: string | null;
  method: string | null;
  httpStatus: number | null;
  userAgent: string | null;
  account: string | null;
}

interface SignalRow {
  ts: number;
  kind: string;
  ip: string | null;
  route: string | null;
  method: string | null;
  http_status: number | null;
  user_agent: string | null;
  account: string | null;
}

function toSignal(row: SignalRow): SignalView {
  return {
    at: new Date(row.ts).toISOString(),
    kind: row.kind,
    ip: row.ip,
    route: row.route,
    method: row.method,
    httpStatus: row.http_status,
    userAgent: row.user_agent,
    account: row.account,
  };
}

/** What the address behind a finding actually sent, newest first. */
export function findingSignals(db: Db, finding: Finding, limit = 50): SignalView[] {
  const rows = db
    .prepare(
      `SELECT ts, kind, ip, route, method, http_status, user_agent, account FROM security_signals
       WHERE project_id IS ? AND ip = ? ORDER BY ts DESC LIMIT ?`,
    )
    .all(finding.projectId, finding.ip, limit) as unknown as SignalRow[];
  return rows.map(toSignal);
}

/** Recent dashboard sign-ins, failures and lock-outs. */
export function recentSignIns(db: Db, limit = 50): SignalView[] {
  const rows = db
    .prepare(
      `SELECT ts, kind, ip, route, method, http_status, user_agent, account FROM security_signals
       WHERE project_id IS NULL AND kind IN ('sign_in', 'login_failed', 'rate_limited') ORDER BY ts DESC LIMIT ?`,
    )
    .all(limit) as unknown as SignalRow[];
  return rows.map(toSignal);
}

export interface SecurityCounts {
  openFindings: number;
  openCritical: number;
  /** Open findings that are informational only (a sign-in from a new address): worth a look, not an attack. */
  openInfo: number;
  resolvedFindings: number;
  /** Distinct addresses behind a finding (other than a new-address sign-in) seen in the last 24 hours. */
  attackingAddresses24h: number;
  signals24h: number;
  /** Dashboard sign-ins refused for a wrong password, and refused because the account or address was locked. */
  failedSignIns24h: number;
  lockedOut24h: number;
}

export function securityCounts(db: Db, now = Date.now()): SecurityCounts {
  const since = now - 86_400_000;
  const findings = db
    .prepare(
      `SELECT COALESCE(SUM(status = 'open'), 0) AS open,
              COALESCE(SUM(status = 'open' AND level >= ${LEVEL_RANK.critical}), 0) AS critical,
              COALESCE(SUM(status = 'open' AND level < ${LEVEL_RANK.warning}), 0) AS info,
              COALESCE(SUM(status = 'resolved'), 0) AS resolved
       FROM security_findings`,
    )
    .get() as { open: number; critical: number; info: number; resolved: number };
  const addresses = db
    .prepare("SELECT COUNT(DISTINCT ip) AS n FROM security_findings WHERE last_seen_at >= ? AND rule != 'new_ip_sign_in'")
    .get(since) as { n: number };
  const signals = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(project_id IS NULL AND kind = 'login_failed'), 0) AS failed,
              COALESCE(SUM(project_id IS NULL AND kind = 'rate_limited'), 0) AS locked
       FROM security_signals WHERE ts >= ? AND kind != 'sign_in'`,
    )
    .get(since) as { n: number; failed: number; locked: number };
  return {
    openFindings: findings.open,
    openCritical: findings.critical,
    openInfo: findings.info,
    resolvedFindings: findings.resolved,
    attackingAddresses24h: addresses.n,
    signals24h: signals.n,
    failedSignIns24h: signals.failed,
    lockedOut24h: signals.locked,
  };
}

export interface ActivityBucket {
  /** Start of the hour, ISO. */
  start: string;
  probes: number;
  signIns: number;
  denied: number;
  errors: number;
}

/**
 * Suspicious requests per hour over the last `hours`, oldest first, in four
 * groups: probes, failed sign-ins (apps and dashboard), denied requests
 * (401/403, lock-outs, bad ingest keys) and server errors.
 */
export function securityActivity(db: Db, hours = 24, now = Date.now()): ActivityBucket[] {
  const HOUR = 3_600_000;
  const first = Math.floor(now / HOUR) * HOUR - (hours - 1) * HOUR;
  const rows = db
    .prepare(
      `SELECT (ts / ${HOUR}) * ${HOUR} AS bucket,
              SUM(kind = 'probe') AS probes,
              SUM(kind = 'login_failed') AS sign_ins,
              SUM(kind IN ('auth_failed', 'rate_limited', 'bad_api_key')) AS denied,
              SUM(kind = 'server_error') AS errors
       FROM security_signals WHERE ts >= ? AND kind != 'sign_in' GROUP BY bucket`,
    )
    .all(first) as unknown as { bucket: number; probes: number; sign_ins: number; denied: number; errors: number }[];
  const byBucket = new Map(rows.map((row) => [row.bucket, row]));
  return Array.from({ length: hours }, (_, i) => {
    const start = first + i * HOUR;
    const row = byBucket.get(start);
    return {
      start: new Date(start).toISOString(),
      probes: row?.probes ?? 0,
      signIns: row?.sign_ins ?? 0,
      denied: row?.denied ?? 0,
      errors: row?.errors ?? 0,
    };
  });
}

/** When the detection pass last finished, for "checked 12 s ago". Null until the first pass. */
export const detectionStatus = { lastRunAt: null as number | null };

// --- detection -------------------------------------------------------------

interface GroupRow {
  project_id: string | null;
  ip: string;
  n: number;
  accounts: number;
  first_ts: number;
  last_ts: number;
}

export interface DetectionResult {
  opened: number;
  updated: number;
  resolved: number;
  /** Synthetic events written to app projects' logs. */
  appAlerts: number;
}

/**
 * One detection pass. Counts each rule's signals per address over the last
 * window, but never before an earlier finding for the same address was
 * resolved: resolving by hand means "seen it", not "tell me again in a minute".
 */
export function runDetection(db: Db, options: { now?: number; alertCooldownMs: number }): DetectionResult {
  const now = options.now ?? Date.now();
  const since = now - DETECTION_WINDOW_MS;
  const result: DetectionResult = { opened: 0, updated: 0, resolved: 0, appAlerts: 0 };

  const lastResolved = db.prepare(
    "SELECT MAX(resolved_at) AS at FROM security_findings WHERE COALESCE(project_id, '') = ? AND rule = ? AND ip = ? AND status = 'resolved'",
  );

  for (const rule of RULES) {
    const kinds = rule.kinds.map(() => "?").join(", ");
    const scope = rule.scope === "self" ? "project_id IS NULL" : "project_id IS NOT NULL";
    const groups = db
      .prepare(
        `SELECT project_id, ip, COUNT(*) AS n, COUNT(DISTINCT account) AS accounts, MIN(ts) AS first_ts, MAX(ts) AS last_ts
         FROM security_signals
         WHERE ts >= ? AND ${scope} AND ip IS NOT NULL AND kind IN (${kinds})
         GROUP BY project_id, ip HAVING COUNT(*) >= ?`,
      )
      .all(since, ...rule.kinds, rule.threshold) as unknown as GroupRow[];

    for (const group of groups) {
      const resolvedAt = (lastResolved.get(group.project_id ?? "", rule.id, group.ip) as { at: number | null }).at;
      let stats = group;
      if (resolvedAt !== null && resolvedAt > since) {
        stats = countSince(db, rule, group.project_id, group.ip, resolvedAt);
        if (stats.n < rule.threshold) continue;
      }
      const outcome = upsertFinding(db, {
        projectId: group.project_id,
        rule: rule.id,
        ip: group.ip,
        level: rule.level(stats.n, stats.accounts),
        firstSeen: stats.first_ts,
        lastSeen: stats.last_ts,
        count: stats.n,
        detail: summarize(db, rule, group.project_id, group.ip, Math.max(since, resolvedAt ?? 0), stats.accounts),
      });
      if (outcome.created) result.opened++;
      else result.updated++;
    }
  }

  // An attack that slows below the threshold is still the same attack: keep
  // its finding alive with whatever the address is still sending.
  const open = db
    .prepare("SELECT id, project_id, rule, ip, first_seen_at, signal_count FROM security_findings WHERE status = 'open' AND rule != 'new_ip_sign_in'")
    .all() as unknown as { id: string; project_id: string | null; rule: RuleId; ip: string; first_seen_at: number; signal_count: number }[];
  for (const finding of open) {
    const rule = RULE_BY_ID.get(finding.rule);
    if (!rule) continue;
    const stats = countSince(db, rule, finding.project_id, finding.ip, finding.first_seen_at - 1);
    if (stats.n === 0) continue;
    db.prepare("UPDATE security_findings SET last_seen_at = MAX(last_seen_at, ?), signal_count = MAX(signal_count, ?) WHERE id = ?").run(
      stats.last_ts,
      stats.n,
      finding.id,
    );
  }

  result.resolved = Number(
    db.prepare("UPDATE security_findings SET status = 'resolved', resolved_at = ? WHERE status = 'open' AND last_seen_at < ?").run(
      now,
      now - FINDING_QUIET_MS,
    ).changes,
  );

  result.appAlerts = queueAppAlerts(db, now, options.alertCooldownMs);
  detectionStatus.lastRunAt = now;
  return result;
}

/** Signals strictly after `since`. */
function countSince(db: Db, rule: Rule, projectId: string | null, ip: string, since: number): GroupRow {
  const kinds = rule.kinds.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT account) AS accounts, MIN(ts) AS first_ts, MAX(ts) AS last_ts
       FROM security_signals WHERE project_id IS ? AND ip = ? AND ts > ? AND kind IN (${kinds})`,
    )
    .get(projectId, ip, since, ...rule.kinds) as { n: number; accounts: number; first_ts: number | null; last_ts: number | null };
  return { project_id: projectId, ip, n: row.n, accounts: row.accounts, first_ts: row.first_ts ?? since, last_ts: row.last_ts ?? since };
}

function summarize(db: Db, rule: Rule, projectId: string | null, ip: string, since: number, accounts: number): FindingDetail {
  const kinds = rule.kinds.map(() => "?").join(", ");
  const routes = db
    .prepare(
      `SELECT route, COUNT(*) AS count FROM security_signals
       WHERE project_id IS ? AND ip = ? AND ts >= ? AND kind IN (${kinds}) AND route IS NOT NULL
       GROUP BY route ORDER BY count DESC LIMIT 5`,
    )
    .all(projectId, ip, since, ...rule.kinds) as unknown as { route: string; count: number }[];
  const byKind = db
    .prepare(
      `SELECT kind, COUNT(*) AS count FROM security_signals
       WHERE project_id IS ? AND ip = ? AND ts >= ? AND kind IN (${kinds}) GROUP BY kind`,
    )
    .all(projectId, ip, since, ...rule.kinds) as unknown as { kind: string; count: number }[];
  // On the dashboard the account is the email someone typed, already in the audit log: name it when there is one.
  const account =
    projectId === null && accounts === 1
      ? (db
          .prepare(`SELECT account FROM security_signals WHERE project_id IS NULL AND ip = ? AND ts >= ? AND kind IN (${kinds}) AND account IS NOT NULL LIMIT 1`)
          .get(ip, since, ...rule.kinds) as { account: string } | undefined)?.account
      : undefined;
  return {
    routes: routes.map((row) => ({ route: row.route, count: row.count })),
    accounts,
    ...(account ? { account } : {}),
    kinds: Object.fromEntries(byKind.map((row) => [row.kind, row.count])),
  };
}

/** True when a finding should be (re)announced: never alerted, or still active after the cooldown. */
function dueForAlert(row: { last_alert_at: number | null; last_seen_at: number }, now: number, cooldownMs: number): boolean {
  return row.last_alert_at === null || (row.last_seen_at > row.last_alert_at && now - row.last_alert_at >= cooldownMs);
}

/**
 * Writes one synthetic event per due app finding into its project's log. The
 * event carries no address: the incident, its Telegram message and the log
 * say *what* is happening, and the Security page says from where.
 */
function queueAppAlerts(db: Db, now: number, cooldownMs: number): number {
  const rows = db
    .prepare(
      `SELECT * FROM security_findings
       WHERE status = 'open' AND project_id IS NOT NULL AND level >= ${LEVEL_RANK.warning}`,
    )
    .all() as unknown as FindingRow[];
  let queued = 0;
  for (const row of rows) {
    if (!dueForAlert(row, now, cooldownMs)) continue;
    const rule = RULE_BY_ID.get(row.rule);
    if (!rule || !row.project_id) continue;
    const detail = row.detail ? (JSON.parse(row.detail) as FindingDetail) : {};
    const event: SuperLogsEvent = {
      level: levelName(row.level),
      message: rule.message,
      event: `security.${rule.id}`,
      service: "super-logs",
      metadata: {
        findingId: row.id,
        rule: rule.id,
        signals: row.signal_count,
        ...(detail.accounts ? { accounts: detail.accounts } : {}),
        ...(detail.routes?.length ? { routes: detail.routes.map((r) => `${r.route} ×${r.count}`) } : {}),
        firstSeen: new Date(row.first_seen_at).toISOString(),
      },
    };
    insertEvents(db, row.project_id, [{ event, ts: now }], now, cooldownMs);
    db.prepare("UPDATE security_findings SET last_alert_at = ? WHERE id = ?").run(now, row.id);
    queued++;
  }
  return queued;
}

/**
 * Sends due findings about Super-Logs itself. They have no project, so they
 * go to every channel an administrator configured. Best effort: a finding is
 * marked alerted after one attempt, so a broken channel cannot make it repeat
 * every minute; the next reminder comes after the cooldown if it continues.
 */
export async function deliverSelfAlerts(
  db: Db,
  channels: AlertChannel[],
  options: { now?: number; alertCooldownMs: number },
): Promise<{ sent: number; failed: number }> {
  const now = options.now ?? Date.now();
  const rows = db
    .prepare(`SELECT * FROM security_findings WHERE status = 'open' AND project_id IS NULL AND level >= ${LEVEL_RANK.warning}`)
    .all() as unknown as FindingRow[];
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    if (!dueForAlert(row, now, options.alertCooldownMs)) continue;
    db.prepare("UPDATE security_findings SET last_alert_at = ? WHERE id = ?").run(now, row.id);
    const alert = selfAlert({ ...row, project_name: null });
    for (const channel of channels) {
      if (channel.accepts && !channel.accepts(alert)) continue;
      try {
        await channel.send(alert);
        sent++;
      } catch {
        failed++;
      }
    }
  }
  return { sent, failed };
}

function selfAlert(row: FindingRow): IncidentAlert {
  const finding = toFinding(row);
  const lines = [`Address: ${finding.ip}`];
  if (finding.detail?.accounts) lines.push(`Accounts tried: ${finding.detail.accounts}`);
  return {
    alertId: 0,
    id: finding.id,
    projectId: "",
    projectName: "Super-Logs",
    fingerprint: hash(`security␟${finding.rule}`),
    status: finding.status,
    level: finding.level,
    eventCount: finding.signalCount,
    firstSeen: finding.firstSeen,
    lastSeen: finding.lastSeen,
    title: finding.message,
    message: lines.join("\n"),
    service: "super-logs",
    route: finding.detail?.routes?.[0]?.route ?? null,
    event: `security.${finding.rule}`,
  };
}

// --- retention -------------------------------------------------------------

export function deleteExpiredSecurityData(db: Db, retentionDays: number, now = Date.now()): { signals: number; findings: number } {
  const cutoff = now - retentionDays * 86_400_000;
  const signals = Number(db.prepare("DELETE FROM security_signals WHERE ts < ?").run(cutoff).changes);
  const findings = Number(db.prepare("DELETE FROM security_findings WHERE status = 'resolved' AND last_seen_at < ?").run(cutoff).changes);
  return { signals, findings };
}
