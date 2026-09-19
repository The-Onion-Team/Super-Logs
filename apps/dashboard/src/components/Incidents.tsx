import type { Incident } from "../api";
import { LevelBadge, relative } from "./bits";

export function Incidents({ incidents, onSelect, onResolve }: {
  incidents: Incident[];
  onSelect: (fingerprint: string) => void;
  onResolve: (incidentId: string) => void;
}) {
  if (incidents.length === 0) return null;

  return (
    <section className="incidents" aria-label="Incidents">
      <div className="section-heading">
        <h2>
          Incidents <span className="muted">· grouped and deduplicated</span>
        </h2>
      </div>
      <div className="incident-list">
        {incidents.map((incident) => (
          <article className={`incident-card incident-${incident.status}`} key={incident.id}>
            <div className="incident-card-head">
              <LevelBadge level={incident.level} />
              <strong>{incident.title}</strong>
              <span className={`incident-status incident-status-${incident.status}`}>{incident.status}</span>
              <span className="muted">last seen {relative(incident.lastSeen)}</span>
            </div>
            <p className="incident-message">{incident.message}</p>
            <div className="incident-meta">
              {incident.service && <span className="tag">{incident.service}</span>}
              {incident.route && <span className="mono muted">{incident.route}</span>}
              <span className="muted">{incident.eventCount.toLocaleString()} event{incident.eventCount === 1 ? "" : "s"}</span>
              <span className="muted">{incident.alertCount} alert{incident.alertCount === 1 ? "" : "s"}</span>
              <button type="button" className="ghost small" onClick={() => onSelect(incident.fingerprint)}>
                View events
              </button>
              {incident.status === "open" && (
                <button type="button" className="ghost small" onClick={() => onResolve(incident.id)}>
                  Resolve
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
