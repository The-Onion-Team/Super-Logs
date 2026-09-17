import type { Project, User } from "../api";
import { Link, navigate } from "../router";
import { BrandMark } from "./bits";

export function Layout(props: {
  user: User;
  projects: Project[];
  path: string;
  onSignOut: () => void;
  children: React.ReactNode;
}) {
  const current = props.path.match(/^\/projects\/([^/]+)/)?.[1];
  const active = (prefix: string) => (props.path.startsWith(prefix) ? "active" : undefined);

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <BrandMark />
          Super-Logs
        </Link>

        {props.projects.length > 0 && (
          <label className="project-picker">
            <span className="visually-hidden">Project</span>
            <select
              value={current ?? ""}
              onChange={(event) => navigate(`/projects/${event.target.value}/logs`)}
            >
              {!current && <option value="">Choose a project</option>}
              {props.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <nav className="nav">
          {current && (
            <Link to={`/projects/${current}/logs`} className={props.path.endsWith("/logs") ? "active" : undefined}>
              Logs
            </Link>
          )}
          <Link to="/projects" className={props.path === "/projects" || props.path.endsWith("/settings") ? "active" : undefined}>
            Projects
          </Link>
          <Link to="/system" className={active("/system")}>
            System
          </Link>
          {props.user.role === "admin" && (
            <Link to="/audit" className={active("/audit")}>
              Audit
            </Link>
          )}
        </nav>

        <div className="account">
          <Link to="/account" className="account-email" title="Change password">
            {props.user.email}
          </Link>
          <button type="button" className="ghost" onClick={props.onSignOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="main">{props.children}</main>
    </div>
  );
}
