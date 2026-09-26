import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, type Project, type SecurityOverview, type StoredEvent, type User } from "../api";
import { Link, navigate } from "../router";
import { BrandMark, relative } from "./bits";

export type ProjectTab = "overview" | "logs" | "settings";

const PROJECT_TABS: { tab: ProjectTab; label: string }[] = [
  { tab: "overview", label: "Overview" },
  { tab: "logs", label: "Logs" },
  { tab: "settings", label: "Settings" },
];

/**
 * Two levels, so what a link acts on is never in doubt: the instance bar
 * (projects, security, system, audit, account) on top, and the current
 * project's own tabs underneath when a project is open.
 */
export function Layout(props: {
  user: User;
  projects: Project[];
  path: string;
  onSignOut: () => void;
  children: ComponentChildren;
}) {
  const match = props.path.match(/^\/projects\/([^/]+)(?:\/(overview|logs|settings))?/);
  const current = match ? props.projects.find((project) => project.id === match[1]) : undefined;
  const tab = (match?.[2] as ProjectTab | undefined) ?? "overview";
  const isAdmin = props.user.role === "admin";
  const [menuOpen, setMenuOpen] = useState(false);
  const openFindings = useOpenFindings(isAdmin);

  // A navigation closes the phone menu.
  useEffect(() => setMenuOpen(false), [props.path]);

  const instanceLinks = [
    { to: "/projects", label: "Projects", active: props.path === "/projects" },
    ...(isAdmin ? [{ to: "/security", label: "Security", active: props.path.startsWith("/security"), badge: openFindings }] : []),
    { to: "/system", label: "System", active: props.path.startsWith("/system") },
    ...(isAdmin ? [{ to: "/audit", label: "Audit", active: props.path.startsWith("/audit") }] : []),
  ];

  return (
    <div className="shell">
      <header className="appbar">
        <div className="appbar-top">
          <Link to="/projects" className="brand">
            <BrandMark />
            <span className="brand-name">Super-Logs</span>
          </Link>

          {props.projects.length > 0 && (
            <label className="project-switch">
              <span className="visually-hidden">Project</span>
              <select
                value={current?.id ?? ""}
                onChange={(event) => navigate(`/projects/${event.currentTarget.value}/${current ? tab : "overview"}`)}
              >
                {!current && <option value="">All projects</option>}
                {props.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <nav className={`instance-nav${menuOpen ? " open" : ""}`} aria-label="Instance" id="instance-nav">
            {instanceLinks.map((link) => (
              <Link key={link.to} to={link.to} className={link.active ? "active" : undefined}>
                {link.label}
                {"badge" in link && link.badge ? (
                  <span className="nav-badge" aria-label={`${link.badge} open findings`}>
                    {link.badge}
                  </span>
                ) : null}
              </Link>
            ))}
            <div className="account">
              <Link to="/account" className="account-link" title="Change password">
                <span className="avatar" aria-hidden="true">
                  {props.user.email.charAt(0).toUpperCase()}
                </span>
                <span className="account-email">{props.user.email}</span>
              </Link>
              <button type="button" className="ghost small" onClick={props.onSignOut}>
                Sign out
              </button>
            </div>
          </nav>

          <button
            type="button"
            className="menu-button"
            aria-expanded={menuOpen}
            aria-controls="instance-nav"
            aria-label="Menu"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {menuOpen ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
            {openFindings > 0 && !menuOpen && <span className="menu-dot" aria-hidden="true" />}
          </button>
        </div>

        {current && (
          <div className="appbar-project">
            <nav className="project-tabs" aria-label={current.name}>
              {PROJECT_TABS.map((item) => (
                <Link
                  key={item.tab}
                  to={`/projects/${current.id}/${item.tab}`}
                  className={tab === item.tab ? "active" : undefined}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <LastEvent projectId={current.id} />
          </div>
        )}
      </header>
      <main className="main">{props.children}</main>
    </div>
  );
}

/** Open security findings, for the badge on the Security link. Administrators only. */
function useOpenFindings(enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const load = () =>
      api<SecurityOverview>("/security/overview").then(
        (overview) => setCount(overview.counts.openFindings - overview.counts.openInfo),
        () => undefined,
      );
    void load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return count;
}

/** "Receiving events · last one 12 s ago": is anything arriving at all? */
function LastEvent({ projectId }: { projectId: string }) {
  const [last, setLast] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setLast(undefined);
    const load = () =>
      api<{ events: StoredEvent[] }>(`/projects/${projectId}/events?limit=1`).then(
        (result) => setLast(result.events[0]?.receivedAt ?? null),
        () => undefined,
      );
    void load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [projectId]);
  if (last === undefined) return null;
  const fresh = last !== null && Date.now() - new Date(last).getTime() < 15 * 60_000;
  return (
    <span className="last-event">
      <span className={`dot ${fresh ? "dot-ok" : "dot-off"}`} aria-hidden="true" />
      {last === null ? "No events yet" : `${fresh ? "Receiving events · " : ""}last one ${relative(last)}`}
    </span>
  );
}
