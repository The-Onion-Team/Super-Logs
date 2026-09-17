import { useEffect, useState } from "react";
import { api, errorMessage, type AuditEntry } from "../api";
import { ErrorNote, Time } from "../components/bits";

export function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ entries: AuditEntry[] }>("/audit").then(
      (result) => setEntries(result.entries),
      (err) => setError(errorMessage(err)),
    );
  }, []);

  return (
    <div className="page">
      <h1>Audit log</h1>
      <p className="muted">Sign-ins and every administrative change, newest first.</p>
      <ErrorNote message={error} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="col-time">When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {entries?.map((entry) => (
              <tr key={entry.id} className={entry.action.endsWith("failed") ? "row-warning" : undefined}>
                <td className="mono">
                  <Time iso={entry.at} />
                </td>
                <td>{entry.actor ?? <span className="muted">system</span>}</td>
                <td className="mono">{entry.action}</td>
                <td className="muted mono">
                  {[entry.target, entry.detail && Object.entries(entry.detail).map(([k, v]) => `${k}=${String(v)}`).join(" ")]
                    .filter(Boolean)
                    .join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries?.length === 0 && <div className="empty">Nothing recorded yet.</div>}
      </div>
    </div>
  );
}
