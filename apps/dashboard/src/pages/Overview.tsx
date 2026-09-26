import { useCallback, useEffect, useState } from "preact/hooks";
import { api, errorMessage, type Incident, type Project, type Stats } from "../api";
import { ErrorNote, LevelBadge, relative } from "../components/bits";
import { ErrorRate, Latency, Sparkline } from "../components/charts";
import { Histogram } from "../components/Histogram";
import { Link, navigate } from "../router";

const TILES = [
  { level: "critical", label: "Critical", link: "View critical events" },
  { level: "error", label: "Errors", link: "View errors" },
  { level: "warning", label: "Warnings", link: "View warnings" },
] as const;

/**
 * A project at a glance: what needs attention first, then what is loudest,
 * then the trends. The log stream itself lives on its own tab.
 */
export function OverviewPage({ project }: { project: Project }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([
        api<Stats>(`/projects/${project.id}/stats?hours=24`),
        api<{ incidents: Incident[] }>(`/projects/${project.id}/incidents?status=open&limit=20`),
      ]);
      setStats(s);
      setIncidents(i.incidents);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const logs = (query: Record<string, string>) => `/projects/${project.id}/logs?${new URLSearchParams(query)}`;
  const total = stats ? Object.values(stats.byLevel).reduce((a, b) => a + b, 0) : 0;

  const resolve = async (incidentId: string) => {
    try {
      await api(`/projects/${project.id}/incidents/${incidentId}/resolve`, { method: "POST", body: {} });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="page overview">
      <div className="page-head">
        <h1>{project.name}</h1>
        <span className="mono muted">{project.slug}</span>
        <span className="page-head-aside muted">Last 24 hours</span>
      </div>
      <ErrorNote message={error} />

      {stats && (
        <div className="kpis">
          {TILES.map((tile) => (
            <Link key={tile.level} to={logs({ level: tile.level, exactLevel: "1" })} className={`kpi kpi-${tile.level}`}>
              <span className="kpi-label">
                <span className={`kpi-dot kpi-dot-${tile.level}`} aria-hidden="true" />
                {tile.label}
              </span>
              <strong>{stats.byLevel[tile.level].toLocaleString()}</strong>
              <span className="kpi-link">{tile.link}</span>
            </Link>
          ))}
          <Link to={logs({})} className="kpi">
            <span className="kpi-label">
              <span className="kpi-dot" aria-hidden="true" />
              All events
            </span>
            <strong>{total.toLocaleString()}</strong>
            <span className="kpi-link">Open the log stream</span>
          </Link>
        </div>
      )}

      <div className="overview-columns">
        <section aria-labelledby="attention-heading" className="stack">
          <div className="section-bar">
            <h2 id="attention-heading">Needs attention</h2>
            {incidents && incidents.length > 0 && (
              <span className="muted small-text">
                {incidents.length} open incident{incidents.length === 1 ? "" : "s"} · grouped and deduplicated
              </span>
            )}
          </div>
          {incidents?.length === 0 && (
            <div className="calm">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12l5 5 9-10" />
              </svg>
              <div>
                <strong>No open incidents</strong>
                <span className="muted">Warnings and errors that repeat become incidents here, and in your alert channel.</span>
              </div>
            </div>
          )}
          {incidents?.map((incident) => (
            <article key={incident.id} className="incident-row">
              <div className="incident-row-head">
                <LevelBadge level={incident.level} />
                <strong title={incident.title}>{incident.title}</strong>
                <span className="muted small-text">{relative(incident.lastSeen)}</span>
              </div>
              <div className="incident-row-meta">
                {(incident.route || incident.service) && <span className="tag">{incident.route ?? incident.service}</span>}
                <span>
                  {incident.eventCount.toLocaleString()} event{incident.eventCount === 1 ? "" : "s"}
                </span>
                <span>
                  {incident.alertCount} alert{incident.alertCount === 1 ? "" : "s"} sent
                </span>
                <span className="incident-row-actions">
                  <Link to={logs({ fingerprint: incident.fingerprint })} className="button-like ghost small">
                    View events
                  </Link>
                  <button type="button" className="ghost small" onClick={() => void resolve(incident.id)}>
                    Resolve
                  </button>
                </span>
              </div>
            </article>
          ))}
        </section>

        <section aria-labelledby="problems-heading" className="stack">
          <div className="section-bar">
            <h2 id="problems-heading">Top problems</h2>
            <span className="muted small-text">by event count</span>
          </div>
          {stats && stats.groups.length === 0 && <div className="calm muted">Nothing above info level in the last 24 hours.</div>}
          {stats && stats.groups.length > 0 && (
            <ol className="problems">
              {stats.groups.map((group) => (
                <li key={group.fingerprint}>
                  <button type="button" onClick={() => navigate(logs({ fingerprint: group.fingerprint }))}>
                    <span className="problem-text">
                      <strong>{group.title}</strong>
                      <span className="muted small-text">
                        {[group.service, group.route, `first seen ${relative(group.firstSeen)}`].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <Sparkline values={group.spark} />
                    <strong className="problem-count">{group.count.toLocaleString()}</strong>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {stats && (
        <section className="charts overview-charts" aria-label="Trends over the last 24 hours">
          <figure className="chart chart-wide">
            <figcaption>
              Events per hour <span className="muted">· grey all events, red errors</span>
            </figcaption>
            <Histogram buckets={stats.hourly} />
          </figure>
          <ErrorRate buckets={stats.hourly} />
          <Latency buckets={stats.latency} />
        </section>
      )}
    </div>
  );
}
