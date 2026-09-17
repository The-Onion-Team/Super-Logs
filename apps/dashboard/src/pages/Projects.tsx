import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, type ApiKey, type Project, type User } from "../api";
import { CopyButton, ErrorNote, relative } from "../components/bits";
import { Link, navigate } from "../router";

export function ProjectsPage(props: { user: User; projects: Project[]; current?: Project; onChange: () => Promise<void> }) {
  const isAdmin = props.user.role === "admin";
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="page">
      <h1>Projects</h1>
      <p className="muted">
        A project is one application. Each has its own ingest keys and its own events.
      </p>

      <ul className="project-list">
        {props.projects.map((project) => (
          <li key={project.id} className={project.id === props.current?.id ? "selected" : undefined}>
            <Link to={`/projects/${project.id}/settings`}>
              <strong>{project.name}</strong> <span className="muted mono">{project.slug}</span>
            </Link>
            <Link to={`/projects/${project.id}/logs`} className="ghost small button-like">
              Logs →
            </Link>
          </li>
        ))}
        {props.projects.length === 0 && <li className="muted">No projects yet.</li>}
      </ul>

      {isAdmin && (
        <form
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const name = String(new FormData(form).get("name") ?? "");
            try {
              const { project } = await api<{ project: Project }>("/projects", { method: "POST", body: { name } });
              form.reset();
              setError(null);
              await props.onChange();
              navigate(`/projects/${project.id}/settings`);
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <input name="name" placeholder="New project name, e.g. My App" required maxLength={80} aria-label="Project name" />
          <button type="submit">Create project</button>
        </form>
      )}
      <ErrorNote message={error} />

      {props.current && <ProjectSettings key={props.current.id} project={props.current} isAdmin={isAdmin} onChange={props.onChange} />}
    </div>
  );
}

function ProjectSettings({ project, isAdmin, onChange }: { project: Project; isAdmin: boolean; onChange: () => Promise<void> }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    if (!isAdmin) return;
    try {
      setKeys((await api<{ keys: ApiKey[] }>(`/projects/${project.id}/keys`)).keys);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project.id, isAdmin]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <section className="settings">
      <h2>{project.name}</h2>
      <ErrorNote message={error} />

      {isAdmin && (
        <>
          <h3>Ingest keys</h3>
          <p className="muted">
            Keys authenticate your <strong>servers</strong>. Never put one in browser code: browsers send events through a relay route on your own server.
          </p>

          {secret && (
            <div className="secret-box" role="status">
              <p>
                <strong>Copy this key now.</strong> It is shown only once.
              </p>
              <div className="secret-row">
                <code>{secret}</code>
                <CopyButton value={secret} />
              </div>
              <button type="button" className="ghost small" onClick={() => setSecret(null)}>
                I stored it
              </button>
            </div>
          )}

          <table className="keys">
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Created</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id} className={key.revokedAt ? "revoked" : undefined}>
                  <td>{key.name}</td>
                  <td className="mono">{key.prefix}…</td>
                  <td>{relative(key.createdAt)}</td>
                  <td>{key.revokedAt ? `revoked ${relative(key.revokedAt)}` : relative(key.lastUsedAt)}</td>
                  <td className="actions">
                    {!key.revokedAt && (
                      <button
                        type="button"
                        className="danger small"
                        onClick={() => {
                          if (!confirm(`Revoke "${key.name}"? Anything still using it will stop sending events.`)) return;
                          void act(async () => {
                            await api(`/projects/${project.id}/keys/${key.id}`, { method: "DELETE" });
                            await loadKeys();
                          });
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
                    No keys yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const name = String(new FormData(form).get("name") ?? "");
              void act(async () => {
                const result = await api<{ secret: string }>(`/projects/${project.id}/keys`, { method: "POST", body: { name } });
                setSecret(result.secret);
                form.reset();
                await loadKeys();
              });
            }}
          >
            <input name="name" placeholder="Key name, e.g. production backend" required maxLength={80} aria-label="Key name" />
            <button type="submit">Create key</button>
          </form>
        </>
      )}

      <h3>Send events</h3>
      <Setup />

      {isAdmin && (
        <>
          <h3>Rename</h3>
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const name = String(new FormData(event.currentTarget).get("name") ?? "");
              void act(async () => {
                await api(`/projects/${project.id}`, { method: "PATCH", body: { name } });
                await onChange();
              });
            }}
          >
            <input name="name" defaultValue={project.name} required maxLength={80} aria-label="Project name" />
            <button type="submit" className="ghost">
              Rename
            </button>
          </form>

          <h3 className="danger-title">Delete project</h3>
          <p className="muted">Deletes the project, its keys and all of its events. This cannot be undone.</p>
          <form
            className="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const confirmText = String(new FormData(event.currentTarget).get("confirm") ?? "");
              void act(async () => {
                await api(`/projects/${project.id}`, { method: "DELETE", body: { confirm: confirmText } });
                await onChange();
                navigate("/projects");
              });
            }}
          >
            <input name="confirm" placeholder={`Type ${project.slug} to confirm`} required aria-label="Confirm slug" autoComplete="off" />
            <button type="submit" className="danger">
              Delete
            </button>
          </form>
        </>
      )}
    </section>
  );
}

function Setup() {
  const origin = location.origin;
  const server = `import { createSuperLogs } from "@super-logs/node";

export const logs = createSuperLogs({
  url: process.env.SUPER_LOGS_URL,        // ${origin}
  apiKey: process.env.SUPER_LOGS_API_KEY, // slk_…
  service: "backend",
  release: process.env.GIT_COMMIT,
  captureConsole: ["error", "warn"],
});

logs.error("Database query failed", { error, queryName: "getLeague" });`;

  const relay = `// Browser events go through your server, which holds the key.
import { createBrowserRelay } from "@super-logs/node";
export const POST = createBrowserRelay(logs);   // e.g. app/api/telemetry/route.ts`;

  const browser = `import { createSuperLogs } from "@super-logs/browser";

const logs = createSuperLogs({ endpoint: "/api/telemetry" });`;

  const curl = `curl -X POST ${origin}/api/ingest \\
  -H "Authorization: Bearer $SUPER_LOGS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"events":[{"level":"error","message":"Hello from curl","service":"shell"}]}'`;

  return (
    <div className="setup">
      {[
        ["Node.js", server],
        ["Browser relay (server side)", relay],
        ["Browser", browser],
        ["Any language (HTTP)", curl],
      ].map(([title, code]) => (
        <div key={title}>
          <div className="setup-head">
            <span>{title}</span>
            <CopyButton value={code!} />
          </div>
          <pre className="code">{code}</pre>
        </div>
      ))}
    </div>
  );
}
