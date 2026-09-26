import { useCallback, useEffect, useState } from "preact/hooks";
import {
  api,
  errorMessage,
  type Project,
  type SecurityActivity,
  type SecurityFinding,
  type SecurityOverview,
  type SecuritySession,
  type SecuritySignal,
} from "../api";
import { ErrorNote, relative } from "../components/bits";

export const RULE_LABELS: Record<SecurityFinding["rule"], string> = {
  brute_force: "Brute-force sign-in attempts",
  scanner: "Vulnerability scanner",
  error_flood: "Burst of server errors",
  dashboard_brute_force: "Dashboard brute force",
  key_guessing: "Ingest key guessing",
  new_ip_sign_in: "Sign-in from a new address",
};

const SIGNAL_LABELS: Record<string, string> = {
  sign_in: "Signed in",
  login_failed: "Wrong password",
  rate_limited: "Locked out",
  auth_failed: "Denied",
  probe: "Probe",
  server_error: "Server error",
  bad_api_key: "Bad ingest key",
};

/** The four groups of the activity chart, in fixed colour order (see `--series-*`). */
const SERIES: { key: keyof Omit<SecurityActivity, "start">; label: string }[] = [
  { key: "probes", label: "Probes" },
  { key: "signIns", label: "Failed sign-ins" },
  { key: "denied", label: "Denied" },
  { key: "errors", label: "Server errors" },
];

const LEVEL_TEXT = { debug: "DEBUG", info: "INFO", warning: "WARN", error: "ERROR", critical: "CRIT" } as const;

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const precise = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** `09:11` today, `Yesterday 18:40`, `Sep 22 07:02` further back. */
function when(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return clock.format(date);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${clock.format(date)}`;
  return `${day.format(date)} ${clock.format(date)}`;
}

/** Browsers announce themselves at length; the name, major version and OS tell sessions apart. */
function shortAgent(agent: string | null): string {
  if (!agent) return "—";
  const match = /(Edg|OPR|Firefox|Chrome|Version)\/(\d+)/.exec(agent);
  const name = match ? ({ Edg: "Edge", OPR: "Opera", Version: "Safari" } as Record<string, string>)[match[1]!] ?? match[1] : null;
  const os = /(Windows|Android|iPhone|iPad|Mac OS X|Linux)/.exec(agent)?.[1]?.replace("Mac OS X", "macOS");
  if (!name && !os) return agent.length > 40 ? `${agent.slice(0, 40)}…` : agent;
  return [name && `${name} ${match![2]}`, os].filter(Boolean).join(" · ");
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function ShieldIcon({ alert }: { alert: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
      {alert ? <path d="M12 8v5M12 16.5v.01" /> : <path d="M8.5 12l2.5 2.5 4.5-5" />}
    </svg>
  );
}

type Status = "open" | "resolved" | "all";

/** Attacks against the monitored apps and against Super-Logs itself. Administrators only. */
export function SecurityPage({ projects }: { projects: Project[] }) {
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [findings, setFindings] = useState<SecurityFinding[] | null>(null);
  const [signIns, setSignIns] = useState<SecuritySignal[] | null>(null);
  const [sessions, setSessions] = useState<SecuritySession[] | null>(null);
  const [status, setStatus] = useState<Status>("open");
  const [scope, setScope] = useState("all");
  const [tab, setTab] = useState<"sessions" | "history">("sessions");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const query = new URLSearchParams({ status });
    if (scope !== "all") query.set("project", scope);
    try {
      const [o, f, s, x] = await Promise.all([
        api<SecurityOverview>("/security/overview"),
        api<{ findings: SecurityFinding[] }>(`/security/findings?${query}`),
        api<{ signIns: SecuritySignal[] }>("/security/sign-ins"),
        api<{ sessions: SecuritySession[] }>("/security/sessions"),
      ]);
      setOverview(o);
      setFindings(f.findings);
      setSignIns(s.signIns);
      setSessions(x.sessions);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [status, scope]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const counts = overview?.counts;
  const underAttack = Boolean(counts && counts.openFindings > counts.openInfo);

  return (
    <div className="page security">
      <div className="sec-head">
        <div className="sec-head-text">
          <h1>Security</h1>
          <p className="muted">
            Attacks on your apps and on Super-Logs itself. Client addresses are kept here only
            {overview ? `, for ${plural(overview.retentionDays, "day")}` : ""}.
          </p>
        </div>
        {counts && (
          <div className={`sec-status ${underAttack ? "sec-status-alert" : "sec-status-ok"}`} role="status">
            <ShieldIcon alert={underAttack} />
            {underAttack ? `Under attack · ${plural(counts.openFindings - counts.openInfo, "open finding")}` : "All quiet"}
          </div>
        )}
        {overview?.lastDetectionAt && <span className="muted small-text">Checked {relative(overview.lastDetectionAt)}</span>}
      </div>
      <ErrorNote message={error} />

      {counts && (
        <div className="sec-tiles">
          <div className="sec-tile">
            <span>Open findings</span>
            <strong className={counts.openFindings - counts.openInfo ? "sec-alert-text" : undefined}>{counts.openFindings}</strong>
            <small>
              {counts.openFindings === 0
                ? "nothing needs you"
                : [counts.openCritical && `${counts.openCritical} critical`, counts.openFindings - counts.openCritical - counts.openInfo && plural(counts.openFindings - counts.openCritical - counts.openInfo, "warning"), counts.openInfo && `${counts.openInfo} to review`]
                    .filter(Boolean)
                    .join(", ")}
            </small>
          </div>
          <div className="sec-tile">
            <span>Attacking addresses</span>
            <strong>{counts.attackingAddresses24h}</strong>
            <small>last 24 h</small>
          </div>
          <div className="sec-tile">
            <span>Suspicious requests</span>
            <strong>{counts.signals24h.toLocaleString()}</strong>
            <small>last 24 h, all projects</small>
          </div>
          <div className="sec-tile">
            <span>Failed dashboard sign-ins</span>
            <strong>{(counts.failedSignIns24h + counts.lockedOut24h).toLocaleString()}</strong>
            <small>
              {plural(counts.failedSignIns24h, "wrong password")}, {counts.lockedOut24h} locked out
            </small>
          </div>
        </div>
      )}

      {overview && <ActivityChart buckets={overview.activity} />}

      <div className="sec-columns">
        <section className="sec-findings" aria-labelledby="findings-heading">
          <div className="sec-bar">
            <h2 id="findings-heading">Findings</h2>
            <div className="segmented" role="group" aria-label="Status">
              {(
                [
                  ["open", `Open${counts ? ` ${counts.openFindings}` : ""}`],
                  ["resolved", `Resolved${counts ? ` ${counts.resolvedFindings}` : ""}`],
                  ["all", "All"],
                ] as [Status, string][]
              ).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={status === value} onClick={() => setStatus(value)}>
                  {label}
                </button>
              ))}
            </div>
            <label className="sec-where">
              Where
              <select value={scope} onChange={(event) => setScope(event.currentTarget.value)}>
                <option value="all">Everywhere</option>
                <option value="self">Super-Logs itself</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {findings?.length === 0 && (
            <div className="sec-empty">
              <ShieldIcon alert={false} />
              <strong>{status === "resolved" ? "No resolved findings" : "Nothing suspicious right now"}</strong>
              <span className="muted">
                Scanners and password guessers show up here within a minute, with the address they came from and every request they sent.
              </span>
            </div>
          )}
          {findings?.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              onResolve={() => act(() => api(`/security/findings/${finding.id}/resolve`, { method: "POST" }))}
            />
          ))}
          {counts && counts.signals24h === 0 && projects.length > 0 && <ConnectHint />}
        </section>

        {overview && <SetupChecks checks={overview.posture} />}
      </div>

      <section className="sec-access" aria-labelledby="access-heading">
        <div className="sec-tabs">
          <h2 id="access-heading">Dashboard access</h2>
          <div role="tablist" aria-label="Dashboard access">
            <button type="button" role="tab" aria-selected={tab === "sessions"} onClick={() => setTab("sessions")}>
              Active sessions{sessions ? ` ${sessions.length}` : ""}
            </button>
            <button type="button" role="tab" aria-selected={tab === "history"} onClick={() => setTab("history")}>
              Sign-in history
            </button>
          </div>
          {tab === "sessions" && sessions && sessions.length > 1 && (
            <button
              type="button"
              className="ghost small sec-tabs-action"
              onClick={() => {
                if (confirm("Sign out every other session, including other users'?")) {
                  void act(() => api("/security/sessions/revoke-others", { method: "POST" }));
                }
              }}
            >
              Sign out all others
            </button>
          )}
        </div>
        {tab === "sessions" ? (
          <Sessions sessions={sessions} onRevoke={(id) => act(() => api(`/security/sessions/${id}`, { method: "DELETE" }))} />
        ) : (
          <SignInHistory signIns={signIns} />
        )}
      </section>
    </div>
  );
}

/** Suspicious requests per hour, stacked by kind. Totals sit in the legend, so no colour has to be read alone. */
function ActivityChart({ buckets }: { buckets: SecurityActivity[] }) {
  const totals = SERIES.map((series) => buckets.reduce((sum, bucket) => sum + bucket[series.key], 0));
  const peak = Math.max(0, ...buckets.map((bucket) => SERIES.reduce((sum, s) => sum + bucket[s.key], 0)));
  const max = peak <= 4 ? 4 : Math.ceil(peak / 4) * 4;
  return (
    <section className="sec-card sec-activity" aria-labelledby="activity-heading">
      <div className="sec-activity-head">
        <h2 id="activity-heading">Suspicious requests, last 24 hours</h2>
        <span className="muted small-text">per hour, every project and the dashboard</span>
        <ul className="sec-legend">
          {SERIES.map((series, i) => (
            <li key={series.key}>
              <span className={`sec-swatch sec-series-${i + 1}`} aria-hidden="true" />
              {series.label} <strong>{totals[i]!.toLocaleString()}</strong>
            </li>
          ))}
        </ul>
      </div>
      <div className="sec-plot">
        <div className="sec-axis" aria-hidden="true">
          <span>{max}</span>
          <span>{max / 2}</span>
          <span>0</span>
        </div>
        <div className="sec-plot-body">
          <div className="sec-bars">
            {buckets.map((bucket) => {
              const hour = clock.format(new Date(bucket.start));
              const parts = SERIES.map((series, i) => ({ ...series, i, value: bucket[series.key] })).filter((part) => part.value > 0);
              const label = `${hour}: ${parts.length ? parts.map((part) => `${part.value} ${part.label.toLowerCase()}`).join(", ") : "nothing"}`;
              return (
                <div className="sec-bar-col" key={bucket.start} title={label} aria-label={label} role="img">
                  {parts.map((part) => (
                    <div key={part.key} className={`sec-seg sec-series-${part.i + 1}`} style={{ height: `${Math.max(3, (part.value / max) * 100)}%` }} />
                  ))}
                </div>
              );
            })}
          </div>
          <div className="sec-hours" aria-hidden="true">
            {buckets.map((bucket, i) => (
              <span key={bucket.start}>{i % 3 === 0 || i === buckets.length - 1 ? clock.format(new Date(bucket.start)).slice(0, 2) : ""}</span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function FindingCard({ finding, onResolve }: { finding: SecurityFinding; onResolve: () => void }) {
  const [signals, setSignals] = useState<SecuritySignal[] | null>(null);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const toggle = async () => {
    setOpen(!open);
    if (open || signals) return;
    try {
      setSignals((await api<{ signals: SecuritySignal[] }>(`/security/findings/${finding.id}`)).signals);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const detail = finding.detail;
  const noun = finding.rule === "dashboard_brute_force" ? "attempt" : "request";
  const meta = [
    `${plural(finding.signalCount, noun)} since ${when(finding.firstSeen)}`,
    detail?.account ? `account: ${detail.account}` : detail?.accounts ? plural(detail.accounts, "account") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const shown = signals?.slice(0, 8) ?? [];

  return (
    <article className={`sec-finding sec-finding-${finding.status}`}>
      <div className="sec-finding-head">
        <span className={`level level-${finding.level}`}>{LEVEL_TEXT[finding.level]}</span>
        <strong>{RULE_LABELS[finding.rule] ?? finding.rule}</strong>
        <span className="sec-chip">{finding.projectName ?? "Super-Logs"}</span>
        <span className="sec-seen muted">
          {finding.status === "resolved" && finding.resolvedAt ? `resolved ${relative(finding.resolvedAt)}` : `last seen ${relative(finding.lastSeen)}`}
        </span>
      </div>
      <p className="sec-finding-text">{finding.message.replace(/^Security: /, "").replace(/^./, (c) => c.toUpperCase())}.</p>
      <div className="sec-finding-meta">
        <div className="sec-ip">
          <span className="mono">{finding.ip}</span>
          <button
            type="button"
            aria-label={copied ? "Copied" : `Copy address ${finding.ip}`}
            title={copied ? "Copied" : "Copy address"}
            onClick={() => void navigator.clipboard?.writeText(finding.ip).then(() => setCopied(true))}
          >
            {copied ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12l5 5 9-10" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="12" height="12" rx="2" />
                <path d="M5 15V5a2 2 0 0 1 2-2h10" />
              </svg>
            )}
          </button>
        </div>
        <span className="muted small-text">{meta}</span>
        <div className="sec-finding-actions">
          <button type="button" className="ghost small" onClick={toggle} aria-expanded={open}>
            {open ? "Hide requests" : "Requests"}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={open ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
            </svg>
          </button>
          {finding.status === "open" && (
            <button type="button" className="ghost small" onClick={onResolve}>
              Resolve
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="sec-finding-detail">
          <ErrorNote message={error} />
          {detail?.routes && detail.routes.length > 0 && (
            <div className="sec-tried">
              <span className="muted small-text">What they tried</span>
              {detail.routes.map((route) => (
                <span key={route.route} className="sec-route mono">
                  {route.route}
                  {route.count > 1 && <span className="muted"> ×{route.count}</span>}
                </span>
              ))}
            </div>
          )}
          <div className="table-wrap sec-requests">
            <table>
              <thead>
                <tr>
                  <th className="col-time">When</th>
                  <th>Request</th>
                  <th>Answer</th>
                  <th>Browser</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((signal, index) => (
                  <tr key={`${signal.at}-${index}`}>
                    <td className="mono muted">{precise.format(new Date(signal.at))}</td>
                    <td className="mono">{[signal.method, signal.route].filter(Boolean).join(" ") || SIGNAL_LABELS[signal.kind] || signal.kind}</td>
                    <td className="mono">{signal.httpStatus ?? "—"}</td>
                    <td className="muted" title={signal.userAgent ?? undefined}>
                      {shortAgent(signal.userAgent)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {signals?.length === 0 && <div className="empty">These requests have passed the retention window.</div>}
          </div>
          {signals && signals.length > shown.length && (
            <span className="muted small-text">
              {plural(signals.length - shown.length, "earlier request")}
              {signals.length === 50 ? " (and possibly more)" : ""}
            </span>
          )}
        </div>
      )}
    </article>
  );
}

function SetupChecks({ checks }: { checks: SecurityOverview["posture"] }) {
  const order = { warn: 0, ok: 1, info: 2 } as const;
  const sorted = [...checks].sort((a, b) => order[a.status] - order[b.status]);
  const scored = checks.filter((check) => check.status !== "info");
  const passing = scored.filter((check) => check.status === "ok").length;
  const warnings = scored.length - passing;
  // On a phone, passing checks fold away behind a toggle while something needs attention (CSS decides the width).
  const [showPassing, setShowPassing] = useState(false);
  const folded = (status: string) => status === "ok" && warnings > 0 && !showPassing;
  return (
    <aside className="sec-checks" aria-labelledby="checks-heading">
      <div className="sec-bar">
        <h2 id="checks-heading">Setup checks</h2>
        <span className={`small-text ${warnings === 0 ? "sec-ok-text" : "muted"}`}>
          {passing} of {scored.length} pass
        </span>
      </div>
      <ul className="sec-card sec-check-list">
        {sorted.map((check) => (
          <li key={check.id} className={`sec-check sec-check-${check.status}${folded(check.status) ? " sec-check-folded" : ""}`}>
            <span className="sec-mark" aria-label={check.status === "ok" ? "Pass" : check.status === "warn" ? "Needs attention" : "Note"}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={check.status === "ok" ? "M5 12l5 5 9-10" : check.status === "warn" ? "M12 7v6M12 17v.01" : "M12 11v6M12 7v.01"} />
              </svg>
            </span>
            <div>
              <strong>{check.title}</strong>
              {check.detail && <p className="muted">{check.detail}</p>}
            </div>
          </li>
        ))}
        {warnings > 0 && passing > 0 && (
          <li className="sec-check-toggle">
            <button type="button" onClick={() => setShowPassing(!showPassing)} aria-expanded={showPassing}>
              {showPassing ? "Hide passing checks" : `Show ${plural(passing, "passing check")}`}
            </button>
          </li>
        )}
      </ul>
    </aside>
  );
}

function ConnectHint() {
  return (
    <div className="sec-card sec-connect">
      <strong>Watch your apps too</strong>
      <p className="muted">
        Turn on security signals in the Node SDK. Your app then reports probes, denied requests and server errors with the client address. Your
        logs stay free of addresses.
      </p>
      <pre>{`createSuperLogs({
  // …
  security: { enabled: true, ipHeader: "cf-connecting-ip" },
});

// what only your code knows:
logs.securitySignal("login_failed", { req, account: email });`}</pre>
    </div>
  );
}

function Sessions({ sessions, onRevoke }: { sessions: SecuritySession[] | null; onRevoke: (id: string) => void }) {
  return (
    <div className="sec-table">
      <table>
        <thead>
          <tr>
            <th>Who</th>
            <th>Address</th>
            <th className="col-route">Browser</th>
            <th className="col-service">Signed in</th>
            <th>Last active</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sessions?.map((session) => (
            <tr key={session.id}>
              <td>{session.email}</td>
              <td className="mono">{session.ip ?? <span className="muted">—</span>}</td>
              <td className="col-route" title={session.userAgent ?? undefined}>
                {shortAgent(session.userAgent)}
              </td>
              <td className="muted col-service">{when(session.createdAt)}</td>
              <td>{relative(session.lastSeenAt)}</td>
              <td className="sec-row-action">
                {session.current ? (
                  <span className="sec-pill-ok">This session</span>
                ) : (
                  <button type="button" className="ghost small" onClick={() => onRevoke(session.id)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface HistoryRow {
  signal: SecuritySignal;
  times: number;
}

/** Consecutive identical attempts (same outcome, address and account) collapse into one row with a count. */
function groupSignIns(signIns: SecuritySignal[]): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const signal of signIns) {
    const last = rows[rows.length - 1];
    if (last && signal.kind !== "sign_in" && last.signal.kind === signal.kind && last.signal.ip === signal.ip && last.signal.account === signal.account) {
      last.times++;
    } else rows.push({ signal, times: 1 });
  }
  return rows;
}

function SignInHistory({ signIns }: { signIns: SecuritySignal[] | null }) {
  if (signIns?.length === 0) return <div className="empty">No sign-ins recorded yet.</div>;
  return (
    <div className="sec-table">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Outcome</th>
            <th className="col-service">Account</th>
            <th>Address</th>
            <th className="col-route">Browser</th>
          </tr>
        </thead>
        <tbody>
          {signIns &&
            groupSignIns(signIns).map(({ signal, times }, index) => {
              const failed = signal.kind !== "sign_in";
              return (
                <tr key={`${signal.at}-${index}`} className={failed ? "row-warning" : undefined}>
                  <td className="muted">{when(signal.at)}</td>
                  <td>
                    <span className={failed ? "sec-bad-text" : "sec-ok-text"}>{SIGNAL_LABELS[signal.kind] ?? signal.kind}</span>
                    {times > 1 && <strong> ×{times}</strong>}
                  </td>
                  <td className="col-service">{signal.account ?? <span className="muted">—</span>}</td>
                  <td className="mono">{signal.ip ?? <span className="muted">unknown</span>}</td>
                  <td className="col-route" title={signal.userAgent ?? undefined}>
                    {shortAgent(signal.userAgent)}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
