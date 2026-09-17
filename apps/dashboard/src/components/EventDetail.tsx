import { useEffect, useState } from "react";
import { api, errorMessage, type StoredEvent } from "../api";
import { CopyButton, ErrorNote, LevelBadge, Time } from "./bits";

type FilterFn = (filters: Record<string, string | undefined>) => void;

export function EventDetail(props: { projectId: string; eventId: string; onClose: () => void; onFilter: FilterFn }) {
  const [event, setEvent] = useState<StoredEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setEvent(null);
    setError(null);
    api<{ event: StoredEvent }>(`/projects/${props.projectId}/events/${props.eventId}`, { signal: controller.signal }).then(
      (result) => setEvent(result.event),
      (err) => setError(errorMessage(err) || null),
    );
    return () => controller.abort();
  }, [props.projectId, props.eventId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  return (
    <>
      <div className="drawer-backdrop" onClick={props.onClose} />
      <aside className="drawer" aria-label="Event details">
        <header className="drawer-head">
          {event ? <LevelBadge level={event.level} /> : <span />}
          <span className="muted mono">#{props.eventId}</span>
          <button type="button" className="ghost" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <ErrorNote message={error} />
        {!event && !error && <div className="empty">Loading…</div>}
        {event && <Body event={event} onFilter={props.onFilter} />}
      </aside>
    </>
  );
}

function Body({ event, onFilter }: { event: StoredEvent; onFilter: FilterFn }) {
  const correlation: [string, string, string | null][] = [
    ["Request", "requestId", event.requestId],
    ["Session", "sessionId", event.sessionId],
    ["User", "userId", event.userId],
  ];
  const facts: [string, React.ReactNode][] = [
    ["Time", <Time iso={event.timestamp} />],
    ["Service", event.service],
    ["Environment", event.environment],
    ["Release", event.release],
    ["Host", event.host],
    ["Event", event.event],
    ["Route", event.route && `${event.method ? `${event.method} ` : ""}${event.route}`],
    ["HTTP status", event.httpStatus],
    ["Duration", event.durationMs !== null ? `${Math.round(event.durationMs)} ms` : null],
    ["Received", <Time iso={event.receivedAt} />],
  ];

  return (
    <div className="drawer-body">
      <h2 className="event-message">{event.message}</h2>

      <div className="correlation">
        {correlation
          .filter(([, , value]) => value)
          .map(([label, key, value]) => (
            <button key={key} type="button" className="chip" onClick={() => onFilter({ [key]: value! })} title={`Show every event with this ${label.toLowerCase()} id`}>
              {label} <span className="mono">{value}</span> →
            </button>
          ))}
        {event.fingerprint && (
          <button type="button" className="chip" onClick={() => onFilter({ fingerprint: event.fingerprint!, level: undefined })} title="Show every occurrence of this problem">
            Same problem →
          </button>
        )}
      </div>

      <dl className="facts">
        {facts
          .filter(([, value]) => value !== null && value !== undefined && value !== "")
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>

      {event.error && (
        <section>
          <h3>
            Error
            {event.error.stack && <CopyButton value={event.error.stack} label="Copy stack" />}
          </h3>
          <p className="mono error-line">
            <strong>{event.error.name ?? "Error"}</strong>
            {event.error.message ? `: ${event.error.message}` : ""}
          </p>
          {event.error.stack && <pre className="code">{event.error.stack}</pre>}
        </section>
      )}

      {event.tags && (
        <section>
          <h3>Tags</h3>
          <div className="chips">
            {Object.entries(event.tags).map(([key, value]) => (
              <button key={key} type="button" className="chip" onClick={() => onFilter({ tag: `${key}:${value}` })}>
                {key}=<strong>{value}</strong>
              </button>
            ))}
          </div>
        </section>
      )}

      {event.metadata && <JsonSection title="Metadata" value={event.metadata} />}
      {event.client && <JsonSection title="Client" value={event.client} />}
    </div>
  );
}

function JsonSection({ title, value }: { title: string; value: unknown }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <section>
      <h3>
        {title}
        <CopyButton value={text} />
      </h3>
      <pre className="code">{text}</pre>
    </section>
  );
}
