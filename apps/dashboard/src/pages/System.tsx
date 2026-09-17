import { useEffect, useState } from "react";
import { api, errorMessage } from "../api";
import { ErrorNote } from "../components/bits";

interface SystemInfo {
  version: string;
  uptimeSeconds: number;
  memoryMb: number;
  database: { bytes: number; events: number };
  retentionDays: number;
  counters: Record<string, number | string | null>;
}

const LABELS: Record<string, string> = {
  ingestRequests: "Ingest requests",
  eventsAccepted: "Events accepted",
  eventsRejected: "Events rejected (invalid)",
  ingestUnauthorized: "Requests with a bad key",
  ingestRateLimited: "Requests rate-limited",
  ingestErrors: "Storage write failures",
  lastIngestMs: "Last batch write (ms)",
  retentionDeleted: "Events deleted by retention",
  retentionLastRun: "Last cleanup",
  retentionLastError: "Last cleanup error",
  loginFailures: "Failed sign-ins",
};

function duration(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
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

  return (
    <div className="page">
      <h1>System</h1>
      <ErrorNote message={error} />
      {info && (
        <>
          <div className="tiles">
            <div className="tile">
              <span>Uptime</span>
              <strong>{duration(info.uptimeSeconds)}</strong>
            </div>
            <div className="tile">
              <span>Memory</span>
              <strong>{info.memoryMb} MB</strong>
            </div>
            <div className="tile">
              <span>Stored events</span>
              <strong>{info.database.events.toLocaleString()}</strong>
            </div>
            <div className="tile">
              <span>Database</span>
              <strong>{(info.database.bytes / 1_048_576).toFixed(1)} MB</strong>
            </div>
            <div className="tile">
              <span>Retention</span>
              <strong>{info.retentionDays} days</strong>
            </div>
          </div>
          <h2>Since the last restart</h2>
          <table className="kv">
            <tbody>
              {Object.entries(LABELS).map(([key, label]) => (
                <tr key={key}>
                  <th>{label}</th>
                  <td className="mono">{info.counters[key] === null || info.counters[key] === undefined ? "—" : String(info.counters[key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Version {info.version}</p>
        </>
      )}
    </div>
  );
}
