import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type Facets, type Project, type Stats, type StoredEvent } from "../api";
import { ErrorNote, LEVEL_ORDER, LevelBadge, Time } from "../components/bits";
import { EventDetail } from "../components/EventDetail";
import { Histogram } from "../components/Histogram";
import { Link, useQueryState } from "../router";

const FILTER_KEYS = ["level", "exactLevel", "service", "environment", "route", "requestId", "sessionId", "userId", "event", "fingerprint", "tag", "from", "to", "q"] as const;

const RANGES: { label: string; hours?: number }[] = [
  { label: "15 min", hours: 0.25 },
  { label: "1 hour", hours: 1 },
  { label: "24 hours", hours: 24 },
  { label: "7 days", hours: 168 },
  { label: "All" },
];

export function LogsPage({ project }: { project: Project }) {
  const [params, setParams] = useQueryState();
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [live, setLive] = useState(true);
  const [search, setSearch] = useState(params.get("q") ?? "");
  const selected = params.get("event_id");

  const filters = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) filters.set(key, value);
  }
  const range = params.get("range");
  if (range && !filters.has("from")) {
    const hours = RANGES.find((r) => r.label === range)?.hours;
    if (hours) filters.set("from", new Date(Date.now() - hours * 3_600_000).toISOString());
  }
  // The range's "from" moves with time; key the query on the range name instead.
  const queryKey = [...filters.entries()].filter(([key]) => key !== "from" || !range).map((e) => e.join("=")).join("&") + `|${range ?? ""}`;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const query = new URLSearchParams(filtersRef.current);
        query.set("limit", "100");
        const result = await api<{ events: StoredEvent[]; nextCursor: string | null }>(
          `/projects/${project.id}/events?${query}`,
          { signal },
        );
        setEvents(result.events);
        setCursor(result.nextCursor);
        setError(null);
      } catch (err) {
        const message = errorMessage(err);
        if (message) setError(message);
      } finally {
        setLoading(false);
      }
    },
    [project.id],
  );

  const loadStats = useCallback(async () => {
    try {
      setStats(await api<Stats>(`/projects/${project.id}/stats?hours=24`));
    } catch {
      /* the header is optional */
    }
  }, [project.id]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void load(controller.signal);
    return () => controller.abort();
  }, [load, queryKey]);

  useEffect(() => {
    void loadStats();
    api<Facets>(`/projects/${project.id}/facets`).then(setFacets, () => undefined);
  }, [project.id, loadStats]);

  // Live tail: refresh while the tab is visible and nothing is being paged.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load();
      void loadStats();
    }, 5_000);
    return () => clearInterval(timer);
  }, [live, load, loadStats]);

  const loadMore = async () => {
    if (!cursor) return;
    setLive(false);
    const query = new URLSearchParams(filters);
    query.set("limit", "100");
    query.set("cursor", cursor);
    try {
      const result = await api<{ events: StoredEvent[]; nextCursor: string | null }>(`/projects/${project.id}/events?${query}`);
      setEvents((current) => [...current, ...result.events]);
      setCursor(result.nextCursor);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const activeChips = FILTER_KEYS.filter((key) => key !== "q" && key !== "exactLevel" && params.get(key));
  const hasEvents = events.length > 0;

  return (
    <div className="page logs">
      <section className="summary" aria-label="Last 24 hours">
        {stats && (
          <>
            <div className="counters">
              {(["critical", "error", "warning"] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  className={`counter counter-${level}${params.get("level") === level ? " selected" : ""}`}
                  onClick={() => setParams({ level: params.get("level") === level ? undefined : level, exactLevel: undefined })}
                >
                  <strong>{stats.byLevel[level].toLocaleString()}</strong>
                  <span>{level === "warning" ? "warnings" : level === "error" ? "errors" : "critical"}</span>
                </button>
              ))}
              <div className="counter">
                <strong>{Object.values(stats.byLevel).reduce((a, b) => a + b, 0).toLocaleString()}</strong>
                <span>events · 24h</span>
              </div>
            </div>
            <Histogram buckets={stats.hourly} />
          </>
        )}
      </section>

      <form
        className="filters"
        onSubmit={(event) => {
          event.preventDefault();
          setParams({ q: search.trim() || undefined });
        }}
      >
        <input
          type="search"
          placeholder="Search messages…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search messages"
        />
        <select
          aria-label="Minimum level"
          value={params.get("level") ?? ""}
          onChange={(event) => setParams({ level: event.target.value || undefined, exactLevel: undefined })}
        >
          <option value="">All levels</option>
          {LEVEL_ORDER.map((level) => (
            <option key={level} value={level}>
              {level} and above
            </option>
          ))}
        </select>
        <select aria-label="Service" value={params.get("service") ?? ""} onChange={(event) => setParams({ service: event.target.value || undefined })}>
          <option value="">All services</option>
          {facets?.services.map((service) => (
            <option key={service}>{service}</option>
          ))}
        </select>
        {facets && facets.environments.length > 1 && (
          <select
            aria-label="Environment"
            value={params.get("environment") ?? ""}
            onChange={(event) => setParams({ environment: event.target.value || undefined })}
          >
            <option value="">All environments</option>
            {facets.environments.map((environment) => (
              <option key={environment}>{environment}</option>
            ))}
          </select>
        )}
        <select aria-label="Time range" value={range ?? "All"} onChange={(event) => setParams({ range: event.target.value === "All" ? undefined : event.target.value, from: undefined, to: undefined })}>
          {RANGES.map((r) => (
            <option key={r.label} value={r.label}>
              {r.label === "All" ? "Any time" : `Last ${r.label}`}
            </option>
          ))}
        </select>
        <input
          aria-label="Route"
          placeholder="Route, e.g. /api/*"
          defaultValue={params.get("route") ?? ""}
          key={`route-${params.get("route") ?? ""}`}
          onBlur={(event) => setParams({ route: event.target.value.trim() || undefined })}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setParams({ route: event.currentTarget.value.trim() || undefined });
            }
          }}
        />
        <label className="toggle">
          <input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />
          Live
        </label>
      </form>

      {activeChips.length > 0 && (
        <div className="chips">
          {activeChips.map((key) => (
            <button key={key} type="button" className="chip" onClick={() => setParams({ [key]: undefined })} title="Remove filter">
              {key}: <strong>{params.get(key)}</strong> ×
            </button>
          ))}
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              setSearch("");
              setParams(Object.fromEntries([...FILTER_KEYS, "range"].map((key) => [key, undefined])));
            }}
          >
            Clear all
          </button>
        </div>
      )}

      <ErrorNote message={error} />

      <div className="table-wrap">
        <table className="events">
          <thead>
            <tr>
              <th className="col-time">Time</th>
              <th className="col-level">Level</th>
              <th className="col-service">Service</th>
              <th>Message</th>
              <th className="col-route">Route</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr
                key={event.id}
                className={`row-${event.level}${selected === String(event.id) ? " selected" : ""}`}
                onClick={() => setParams({ event_id: String(event.id) })}
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && setParams({ event_id: String(event.id) })}
              >
                <td className="col-time mono">
                  <Time iso={event.timestamp} />
                </td>
                <td className="col-level">
                  <LevelBadge level={event.level} />
                </td>
                <td className="col-service">{event.service ?? <span className="muted">—</span>}</td>
                <td className="col-message">
                  {event.httpStatus ? <span className="status">{event.httpStatus}</span> : null}
                  {event.message}
                  {event.tags &&
                    Object.entries(event.tags)
                      .slice(0, 3)
                      .map(([key, value]) => (
                        <span key={key} className="tag">
                          {key}={value}
                        </span>
                      ))}
                </td>
                <td className="col-route mono">
                  {event.method && <span className="muted">{event.method} </span>}
                  {event.route}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !hasEvents && !error && (
          <div className="empty">
            {activeChips.length || params.get("q") || range ? (
              "No events match these filters."
            ) : (
              <>
                No events yet. <Link to={`/projects/${project.id}/settings`}>Create an ingest key</Link> and send your first one.
              </>
            )}
          </div>
        )}
        {cursor && (
          <div className="more">
            <button type="button" className="ghost" onClick={loadMore}>
              Load older events
            </button>
          </div>
        )}
      </div>

      {selected && (
        <EventDetail
          projectId={project.id}
          eventId={selected}
          onClose={() => setParams({ event_id: undefined })}
          onFilter={(next) => {
            setLive(true);
            setParams({ ...next, event_id: undefined });
          }}
        />
      )}
    </div>
  );
}
