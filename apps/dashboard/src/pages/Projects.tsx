import { useEffect, useState } from "preact/hooks";
import { api, errorMessage, type Project, type Stats, type StoredEvent, type User } from "../api";
import { ErrorNote, relative } from "../components/bits";
import { Link, navigate } from "../router";

interface Health {
  events: number;
  problems: number;
  openIncidents: number;
  lastEvent: string | null;
  hourly: Stats["hourly"];
}

/** Every project with its last day at a glance: is it healthy, is it even sending? */
export function ProjectsPage(props: { user: User; projects: Project[]; onChange: () => Promise<void> }) {
  const isAdmin = props.user.role === "admin";
  const [health, setHealth] = useState<Record<string, Health>>({});
  const [adding, setAdding] = useState(props.projects.length === 0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      for (const project of props.projects) {
        Promise.all([
          api<Stats>(`/projects/${project.id}/stats?hours=24`),
          api<{ incidents: unknown[] }>(`/projects/${project.id}/incidents?status=open&limit=100`),
          api<{ events: StoredEvent[] }>(`/projects/${project.id}/events?limit=1`),
        ]).then(
          ([stats, incidents, latest]) => {
            if (cancelled) return;
            setHealth((current) => ({
              ...current,
              [project.id]: {
                events: Object.values(stats.byLevel).reduce((a, b) => a + b, 0),
                problems: stats.byLevel.error + stats.byLevel.critical,
                openIncidents: incidents.incidents.length,
                lastEvent: latest.events[0]?.receivedAt ?? null,
                hourly: stats.hourly,
              },
            }));
          },
          () => undefined,
        );
      }
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [props.projects]);

  return (
    <div className="page projects-page">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="muted">One project per application. Each has its own ingest keys, events and alerts.</p>
        </div>
        {isAdmin && !adding && (
          <button type="button" className="page-head-aside" onClick={() => setAdding(true)}>
            New project
          </button>
        )}
      </div>
      <ErrorNote message={error} />

      <div className="project-grid">
        {props.projects.map((project) => (
          <ProjectCard key={project.id} project={project} health={health[project.id]} />
        ))}

        {isAdmin && adding && (
          <form
            className="project-card project-new"
            onSubmit={async (event) => {
              event.preventDefault();
              const name = String(new FormData(event.currentTarget).get("name") ?? "");
              try {
                const { project } = await api<{ project: Project }>("/projects", { method: "POST", body: { name } });
                setError(null);
                await props.onChange();
                navigate(`/projects/${project.id}/settings`);
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            <strong>Add a project</strong>
            <span className="muted small-text">You get an ingest key and copy-paste setup for Node.js, the browser or plain HTTP.</span>
            <label>
              <span>Name</span>
              <input name="name" placeholder="e.g. Checkout API" required maxLength={80} autoFocus={props.projects.length > 0} />
            </label>
            <div className="project-new-actions">
              <button type="submit">Create project</button>
              {props.projects.length > 0 && (
                <button type="button" className="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}
      </div>
      {!isAdmin && props.projects.length === 0 && <div className="empty">No projects yet. An administrator can create one.</div>}
    </div>
  );
}

function ProjectCard({ project, health }: { project: Project; health: Health | undefined }) {
  const status = !health
    ? null
    : health.openIncidents > 0
      ? { tone: "bad", text: `${health.openIncidents} open incident${health.openIncidents === 1 ? "" : "s"}` }
      : health.lastEvent === null
        ? { tone: "off", text: "No events yet" }
        : { tone: "ok", text: "Healthy" };
  const max = Math.max(1, ...(health?.hourly.map((hour) => hour.total) ?? []));

  return (
    <article className="project-card">
      <div className="project-card-head">
        <div>
          <Link to={`/projects/${project.id}/overview`} className="project-name">
            {project.name}
          </Link>
          <span className="mono muted small-text">{project.slug}</span>
        </div>
        {status && <span className={`status-pill status-${status.tone}`}>{status.text}</span>}
      </div>

      <div className="project-spark" role="img" aria-label="Events per hour over the last 24 hours, errors in red">
        {health?.hourly.map((hour) => (
          <span
            key={hour.start}
            className={hour.errors > 0 ? "has-errors" : undefined}
            style={{ height: `${hour.total ? Math.max(6, (hour.total / max) * 100) : 3}%` }}
            title={`${new Date(hour.start).getHours()}:00 · ${hour.total} events, ${hour.errors} errors`}
          />
        ))}
      </div>

      <dl className="project-stats">
        <div>
          <dt>Events, 24 h</dt>
          <dd>{health ? health.events.toLocaleString() : "—"}</dd>
        </div>
        <div>
          <dt>Errors</dt>
          <dd className={health?.problems ? "bad-text" : undefined}>{health ? health.problems.toLocaleString() : "—"}</dd>
        </div>
        <div>
          <dt>Last event</dt>
          <dd>{health ? (health.lastEvent ? relative(health.lastEvent) : "—") : "—"}</dd>
        </div>
      </dl>

      <div className="project-actions">
        <Link to={`/projects/${project.id}/overview`} className="button-like ghost">
          Overview
        </Link>
        <Link to={`/projects/${project.id}/logs`} className="button-like ghost">
          Logs
        </Link>
        <Link to={`/projects/${project.id}/settings`} className="button-like ghost icon-button" title={`Settings for ${project.name}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
          <span className="visually-hidden">Settings</span>
        </Link>
      </div>
    </article>
  );
}
