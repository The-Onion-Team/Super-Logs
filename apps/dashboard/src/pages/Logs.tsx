import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { api, errorMessage, type Facets, type Project, type StoredEvent } from "../api";
import { ErrorNote, Time } from "../components/bits";
import { EventDetail } from "../components/EventDetail";
import { Link, useQueryState } from "../router";

const FILTER_KEYS = ["level", "exactLevel", "service", "environment", "route", "requestId", "sessionId", "userId", "event", "fingerprint", "tag", "from", "to", "q"] as const;

/** Minimum level, as one segmented control: the four views people actually switch between. */
const LEVEL_VIEWS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "warning", label: "Warnings+" },
  { value: "error", label: "Errors+" },
  { value: "critical", label: "Critical" },
];

const LEVEL_LABEL: Record<string, string> = { debug: "Debug", info: "Info", warning: "Warning", error: "Error", critical: "Critical" };

const FILTER_LABELS: Record<string, string> = {
  level: "level",
  service: "service",
  environment: "environment",
  route: "route",
  requestId: "request",
  sessionId: "session",
  userId: "user",
  event: "event",
  fingerprint: "same problem",
  tag: "tag",
  from: "from",
  to: "to",
};

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
  const [facets, setFacets] = useState<Facets | null>(null);
  const [showFilters, setShowFilters] = useState(false);
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

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void load(controller.signal);
    return () => controller.abort();
  }, [load, queryKey]);

  useEffect(() => {
    api<Facets>(`/projects/${project.id}/facets`).then(setFacets, () => undefined);
  }, [project.id]);

  // Live tail: refresh while the tab is visible and nothing is being paged.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load();
    }, 5_000);
    return () => clearInterval(timer);
  }, [live, load]);

  // "/" jumps to the search box, as in most log tools.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || target?.closest("input, textarea, select")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const levelView = params.get("exactLevel") ? null : params.get("level") ?? "";
  const extraFilters = ["service", "environment", "range", "route"].filter((key) => params.get(key)).length;

  return (
    <div className="page logs">
      <form
        className={`toolbar${showFilters ? " show-filters" : ""}`}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setParams({ q: search.trim() || undefined });
        }}
      >
        <label className="search-field">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <span className="visually-hidden">Search messages</span>
          <input
            ref={searchRef}
            type="search"
            placeholder="Search messages, errors and event names"
            value={search}
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
          <kbd aria-hidden="true">/</kbd>
        </label>
        <button type="button" className="ghost filters-toggle" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>
          Filters{extraFilters ? <span className="count-badge">{extraFilters}</span> : null}
        </button>
        <div className="segmented" role="group" aria-label="Minimum level">
          {LEVEL_VIEWS.map((view) => (
            <button
              key={view.value}
              type="button"
              aria-pressed={levelView === view.value}
              onClick={() => setParams({ level: view.value || undefined, exactLevel: undefined })}
            >
              {view.label}
            </button>
          ))}
        </div>
        <div className="toolbar-filters">
          <select aria-label="Service" value={params.get("service") ?? ""} onChange={(event) => setParams({ service: event.currentTarget.value || undefined })}>
            <option value="">All services</option>
            {facets?.services.map((service) => (
              <option key={service}>{service}</option>
            ))}
          </select>
          {facets && facets.environments.length > 1 && (
            <select
              aria-label="Environment"
              value={params.get("environment") ?? ""}
              onChange={(event) => setParams({ environment: event.currentTarget.value || undefined })}
            >
              <option value="">All environments</option>
              {facets.environments.map((environment) => (
                <option key={environment}>{environment}</option>
              ))}
            </select>
          )}
          <select
            aria-label="Time range"
            value={range ?? "All"}
            onChange={(event) => setParams({ range: event.currentTarget.value === "All" ? undefined : event.currentTarget.value, from: undefined, to: undefined })}
          >
            {RANGES.map((r) => (
              <option key={r.label} value={r.label}>
                {r.label === "All" ? "Any time" : `Last ${r.label}`}
              </option>
            ))}
          </select>
          <input
            aria-label="Route"
            className="route-filter"
            placeholder="Route, e.g. /api/*"
            defaultValue={params.get("route") ?? ""}
            key={`route-${params.get("route") ?? ""}`}
            onBlur={(event) => setParams({ route: event.currentTarget.value.trim() || undefined })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                setParams({ route: event.currentTarget.value.trim() || undefined });
              }
            }}
          />
        </div>
        <button type="button" className={`live-toggle${live ? " on" : ""}`} aria-pressed={live} onClick={() => setLive(!live)} title={live ? "Pause live updates" : "Resume live updates"}>
          <span className="live-dot" aria-hidden="true" />
          {live ? "Live" : "Paused"}
        </button>
      </form>

      {activeChips.length > 0 && (
        <div className="chips">
          {activeChips.map((key) => (
            <button key={key} type="button" className="chip" onClick={() => setParams({ [key]: undefined, ...(key === "level" ? { exactLevel: undefined } : {}) })} title="Remove filter">
              {FILTER_LABELS[key] ?? key}:{" "}
              <strong>
                {key === "fingerprint" ? params.get(key)!.slice(0, 8) : params.get(key)}
                {key === "level" && params.get("exactLevel") ? " only" : key === "level" ? " and above" : ""}
              </strong>{" "}
              ×
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

      <p className="stream-meta muted small-text">
        {loading && !hasEvents ? "Loading…" : `${events.length}${cursor ? "+" : ""} event${events.length === 1 ? "" : "s"}, newest first`}
        {hasEvents && " · select one for its details, request and session"}
      </p>

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
                  <span className={`level-dot level-dot-${event.level}`}>{LEVEL_LABEL[event.level]}</span>
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
