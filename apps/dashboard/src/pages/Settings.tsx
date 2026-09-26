import { useCallback, useEffect, useState } from "preact/hooks";
import { api, errorMessage, type ApiKey, type Project, type User } from "../api";
import { CopyButton, ErrorNote, relative } from "../components/bits";
import { Notifications } from "../components/Notifications";
import { navigate } from "../router";

const SECTIONS = [
  { id: "keys", label: "Ingest keys", admin: true },
  { id: "connect", label: "Connect your app", admin: false },
  { id: "alerts", label: "Alerts", admin: true },
  { id: "general", label: "General", admin: true },
  { id: "danger", label: "Danger zone", admin: true },
] as const;

/** One project's settings, as sections with a side menu instead of one long page. */
export function SettingsPage({ user, project, onChange }: { user: User; project: Project; onChange: () => Promise<void> }) {
  const isAdmin = user.role === "admin";
  const sections = SECTIONS.filter((section) => isAdmin || !section.admin);
  const [active, setActive] = useState<string>(sections[0]!.id);

  // Highlight the section being read.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: "-120px 0px -60% 0px" },
    );
    for (const section of sections) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [project.id, isAdmin]);

  return (
    <div className="page settings-page">
      <nav className="settings-nav" aria-label="Settings sections">
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className={`${active === section.id ? "active" : ""}${section.id === "danger" ? " danger-link" : ""}`}
            aria-current={active === section.id ? "true" : undefined}
            onClick={(event) => {
              event.preventDefault();
              document.getElementById(section.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
              setActive(section.id);
            }}
          >
            {section.label}
          </a>
        ))}
      </nav>
      <div className="settings-sections">
        {isAdmin && <Keys project={project} />}
        <section id="connect" className="panel" aria-labelledby="connect-heading">
          <div className="panel-head">
            <div>
              <h2 id="connect-heading">Connect your app</h2>
              <p className="muted">Pick how your app talks to Super-Logs. The address below is already this server's.</p>
            </div>
          </div>
          <Setup />
        </section>
        {isAdmin && (
          <section id="alerts" className="panel" aria-label="Alerts">
            <Notifications projectId={project.id} />
          </section>
        )}
        {isAdmin && <General project={project} onChange={onChange} />}
        {isAdmin && <Danger project={project} onChange={onChange} />}
      </div>
    </div>
  );
}

function Keys({ project }: { project: Project }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys((await api<{ keys: ApiKey[] }>(`/projects/${project.id}/keys`)).keys);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const live = keys.filter((key) => !key.revokedAt);
  const revoked = keys.filter((key) => key.revokedAt);

  return (
    <section id="keys" className="panel" aria-labelledby="keys-heading">
      <div className="panel-head">
        <div>
          <h2 id="keys-heading">Ingest keys</h2>
          <p className="muted">
            Your servers send events with these. Never put a key in browser code: browsers go through a relay route on your server.
          </p>
        </div>
        {!creating && (
          <button type="button" onClick={() => setCreating(true)}>
            New key
          </button>
        )}
      </div>
      <ErrorNote message={error} />

      {creating && (
        <form
          className="inline-form panel-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const name = String(new FormData(form).get("name") ?? "");
            try {
              const result = await api<{ secret: string }>(`/projects/${project.id}/keys`, { method: "POST", body: { name } });
              setSecret({ name, value: result.secret });
              setCreating(false);
              setError(null);
              await load();
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <input name="name" placeholder="Key name, e.g. production backend" required maxLength={80} aria-label="Key name" autoFocus />
          <button type="submit">Create key</button>
          <button type="button" className="ghost" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      )}

      {secret && (
        <div className="secret-box" role="status">
          <strong>Key “{secret.name}” created. Copy it now: it is shown only once.</strong>
          <div className="secret-row">
            <code>{secret.value}</code>
            <CopyButton value={secret.value} />
            <button type="button" className="ghost small" onClick={() => setSecret(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      <div className="panel-table-wrap">
      <table className="panel-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th className="col-service">Created</th>
            <th>Last used</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {[...live, ...revoked].map((key) => (
            <tr key={key.id} className={key.revokedAt ? "revoked" : undefined}>
              <td>{key.name}</td>
              <td className="mono">{key.prefix}…</td>
              <td className="col-service muted">{relative(key.createdAt)}</td>
              <td>
                {key.revokedAt ? (
                  <span className="muted">revoked {relative(key.revokedAt)}</span>
                ) : (
                  <span className="key-used">
                    <span className={`dot ${key.lastUsedAt && Date.now() - new Date(key.lastUsedAt).getTime() < 86_400_000 ? "dot-ok" : "dot-off"}`} aria-hidden="true" />
                    {relative(key.lastUsedAt)}
                  </span>
                )}
              </td>
              <td className="actions">
                {!key.revokedAt && (
                  <button
                    type="button"
                    className="ghost small danger-outline"
                    onClick={async () => {
                      if (!confirm(`Revoke "${key.name}"? Anything still using it will stop sending events.`)) return;
                      try {
                        await api(`/projects/${project.id}/keys/${key.id}`, { method: "DELETE" });
                        await load();
                      } catch (err) {
                        setError(errorMessage(err));
                      }
                    }}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
          {keys.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No keys yet. Create one to start sending events.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </section>
  );
}

function General({ project, onChange }: { project: Project; onChange: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  return (
    <section id="general" className="panel" aria-labelledby="general-heading">
      <div className="panel-head">
        <h2 id="general-heading">General</h2>
      </div>
      <form
        className="general-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const name = String(new FormData(event.currentTarget).get("name") ?? "");
          try {
            await api(`/projects/${project.id}`, { method: "PATCH", body: { name } });
            await onChange();
            setError(null);
            setSaved(true);
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <label>
          <span>Name</span>
          <input name="name" defaultValue={project.name} required maxLength={80} onInput={() => setSaved(false)} />
        </label>
        <label>
          <span>Slug, used to confirm deletion</span>
          <input value={project.slug} readOnly className="mono" />
        </label>
        <div className="general-actions">
          <button type="submit" className="ghost">
            Save name
          </button>
          {saved && <span className="ok-text small-text">Saved</span>}
        </div>
      </form>
      <ErrorNote message={error} />
    </section>
  );
}

function Danger({ project, onChange }: { project: Project; onChange: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section id="danger" className="panel panel-danger" aria-labelledby="danger-heading">
      <div className="panel-head">
        <div>
          <h2 id="danger-heading">Delete this project</h2>
          <p className="muted">
            Removes {project.name}, its keys, events, incidents and alerts. This cannot be undone.
          </p>
        </div>
        {!confirming && (
          <button type="button" className="ghost danger-outline" onClick={() => setConfirming(true)}>
            Delete project…
          </button>
        )}
      </div>
      {confirming && (
        <form
          className="inline-form panel-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const confirmText = String(new FormData(event.currentTarget).get("confirm") ?? "");
            try {
              await api(`/projects/${project.id}`, { method: "DELETE", body: { confirm: confirmText } });
              await onChange();
              navigate("/projects");
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <input name="confirm" placeholder={`Type ${project.slug} to confirm`} required aria-label="Confirm slug" autoComplete="off" autoFocus />
          <button type="submit" className="danger">
            Delete forever
          </button>
          <button type="button" className="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </form>
      )}
      <ErrorNote message={error} />
    </section>
  );
}

function Setup() {
  const origin = location.origin;
  const snippets = [
    {
      id: "node",
      label: "Node.js server",
      code: `import { createSuperLogs } from "@super-logs/node";

export const logs = createSuperLogs({
  url: process.env.SUPER_LOGS_URL,        // ${origin}
  apiKey: process.env.SUPER_LOGS_API_KEY, // slk_…
  service: "backend",
  release: process.env.GIT_COMMIT,
  captureConsole: ["error", "warn"],
});

logs.error("Database query failed", { error, queryName: "getLeague" });`,
      hint: "Wrap each request with logs.runWithRequest(req, res, next) to correlate everything it logs.",
    },
    {
      id: "browser",
      label: "Browser",
      code: `// On your server, which holds the key:
import { createBrowserRelay } from "@super-logs/node";
export const POST = createBrowserRelay(logs);   // e.g. app/api/telemetry/route.ts

// In the browser:
import { createSuperLogs } from "@super-logs/browser";
const logs = createSuperLogs({ endpoint: "/api/telemetry" });`,
      hint: "Browser events travel through your own server, so the key never reaches the page.",
    },
    {
      id: "http",
      label: "Any language",
      code: `curl -X POST ${origin}/api/ingest \\
  -H "Authorization: Bearer $SUPER_LOGS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"events":[{"level":"error","message":"Hello from curl","service":"shell"}]}'`,
      hint: "Up to 100 events per request. Each one is validated on its own.",
    },
  ];
  const [tab, setTab] = useState(snippets[0]!.id);
  const current = snippets.find((snippet) => snippet.id === tab)!;
  return (
    <div className="setup-tabs">
      <div className="tabs-row">
        <div role="tablist" aria-label="Setup" className="tabs">
          {snippets.map((snippet) => (
            <button key={snippet.id} type="button" role="tab" aria-selected={tab === snippet.id} onClick={() => setTab(snippet.id)}>
              {snippet.label}
            </button>
          ))}
        </div>
        <CopyButton value={current.code} />
      </div>
      <div className="code-block" role="tabpanel">
        <pre className="code">{current.code}</pre>
      </div>
      <p className="muted small-text">{current.hint}</p>
    </div>
  );
}
