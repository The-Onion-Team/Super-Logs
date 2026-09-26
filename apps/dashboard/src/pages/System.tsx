import { useEffect, useState } from "preact/hooks";
import { api, errorMessage } from "../api";
import { ErrorNote, relative } from "../components/bits";

interface SystemInfo {
  version: string;
  uptimeSeconds: number;
  memoryMb: number;
  database: { bytes: number; events: number };
  retentionDays: number;
  counters: Record<string, number | string | null>;
}

type Tone = "normal" | "warn" | "muted";

/** Counters grouped by what they are about. A non-zero "bad" counter is highlighted; a zero one recedes. */
const GROUPS: { title: string; rows: { key: string; label: string; bad?: boolean; format?: (value: number | string) => string }[] }[] = [
  {
    title: "Ingestion",
    rows: [
      { key: "ingestRequests", label: "Requests" },
      { key: "eventsAccepted", label: "Events accepted" },
      { key: "eventsRejected", label: "Events rejected as invalid", bad: true },
      { key: "ingestUnauthorized", label: "Requests with a bad key", bad: true },
      { key: "ingestRateLimited", label: "Requests rate-limited", bad: true },
      { key: "securitySignals", label: "Security signals" },
      { key: "lastIngestMs", label: "Last batch write", format: (value) => `${value} ms` },
    ],
  },
  {
    title: "Storage",
    rows: [
      { key: "ingestErrors", label: "Write failures", bad: true },
      { key: "retentionDeleted", label: "Events deleted by retention" },
      { key: "retentionLastRun", label: "Last cleanup", format: (value) => relative(String(value)) },
      { key: "retentionLastError", label: "Last cleanup error", bad: true },
    ],
  },
  {
    title: "Alerts and sign-ins",
    rows: [
      { key: "alertsSent", label: "Alerts sent" },
      { key: "alertsFailed", label: "Alerts that failed", bad: true },
      { key: "securityFindingsOpened", label: "Security findings opened" },
      { key: "loginFailures", label: "Failed dashboard sign-ins", bad: true },
    ],
  },
];

function duration(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m} min`;
}

function size(bytes: number): string {
  return bytes >= 1_073_741_824 ? `${(bytes / 1_073_741_824).toFixed(1)} GB` : `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** Super-Logs watching itself. Counters reset when the server restarts. */
export function SystemPage() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api<SystemInfo>("/system").then(
        (result) => {
          setInfo(result);
          setError(null);
        },
        (err) => setError(errorMessage(err)),
      );
    void load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, []);

  const c = info?.counters ?? {};
  const cleanupError = c.retentionLastError;
  const writeFailures = Number(c.ingestErrors ?? 0);
  const healthy = !cleanupError && writeFailures === 0;

  return (
    <div className="page system-page">
      <div className="page-head">
        <div>
          <h1>System</h1>
          <p className="muted">Super-Logs watching itself. Counters start again when the server restarts.</p>
        </div>
        {info && (
          <div className="page-head-aside system-status">
            <span className={`status-pill status-${healthy ? "ok" : "bad"}`}>
              {healthy ? "Healthy" : "Needs a look"} · up {duration(info.uptimeSeconds)}
            </span>
            <span className="muted small-text">Version {info.version}</span>
          </div>
        )}
      </div>
      <ErrorNote message={error} />
      {info && (
        <>
          <div className="kpis">
            <div className="kpi static">
              <span className="kpi-label">Memory</span>
              <strong>{info.memoryMb} MB</strong>
              <span className="muted small-text">resident, this process</span>
            </div>
            <div className="kpi static">
              <span className="kpi-label">Database</span>
              <strong>{size(info.database.bytes)}</strong>
              <span className="muted small-text">{info.database.events.toLocaleString()} events stored</span>
            </div>
            <div className="kpi static">
              <span className="kpi-label">Retention</span>
              <strong>{info.retentionDays} days</strong>
              <span className="muted small-text">then events are deleted</span>
            </div>
            <div className="kpi static">
              <span className="kpi-label">Last cleanup</span>
              <strong>{c.retentionLastRun ? relative(String(c.retentionLastRun)) : "not yet"}</strong>
              <span className={`small-text ${cleanupError ? "bad-text" : "muted"}`}>{cleanupError ? String(cleanupError) : "no errors"}</span>
            </div>
          </div>
          <div className="system-groups">
            {GROUPS.map((group) => (
              <section key={group.title} className="panel system-group" aria-label={group.title}>
                <h2>{group.title}</h2>
                <dl>
                  {group.rows.map((row) => {
                    const value = c[row.key];
                    const empty = value === null || value === undefined || value === 0 || value === "";
                    const tone: Tone = row.bad && !empty ? "warn" : empty ? "muted" : "normal";
                    return (
                      <div key={row.key} className={`tone-${tone}`}>
                        <dt>{row.label}</dt>
                        <dd>{empty ? (typeof value === "number" ? "0" : "none") : row.format ? row.format(value!) : typeof value === "number" ? value.toLocaleString() : String(value)}</dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
