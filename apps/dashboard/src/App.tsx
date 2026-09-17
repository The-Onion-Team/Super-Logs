import { useCallback, useEffect, useState } from "react";
import { api, onUnauthenticated, type Project, type User } from "./api";
import { Layout } from "./components/Layout";
import { Redirect, navigate, useLocation } from "./router";
import { AuditPage } from "./pages/Audit";
import { ChangePasswordPage } from "./pages/ChangePassword";
import { LoginPage } from "./pages/Login";
import { LogsPage } from "./pages/Logs";
import { ProjectsPage } from "./pages/Projects";
import { SystemPage } from "./pages/System";

type Session = { state: "loading" } | { state: "anonymous" } | { state: "signed-in"; user: User };

export function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });
  const [projects, setProjects] = useState<Project[] | null>(null);
  const { path } = useLocation();

  const loadSession = useCallback(async () => {
    try {
      const { user } = await api<{ user: User }>("/auth/me");
      setSession({ state: "signed-in", user });
    } catch {
      setSession({ state: "anonymous" });
    }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      setProjects((await api<{ projects: Project[] }>("/projects")).projects);
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void loadSession();
    return onUnauthenticated(() => setSession({ state: "anonymous" }));
  }, [loadSession]);

  const ready = session.state === "signed-in" && !session.user.mustChangePassword;
  useEffect(() => {
    if (ready) void loadProjects();
  }, [ready, loadProjects]);

  if (session.state === "loading") return <div className="splash" aria-busy="true" />;
  if (session.state === "anonymous") return <LoginPage onSignedIn={(user) => setSession({ state: "signed-in", user })} />;
  if (session.user.mustChangePassword) {
    return (
      <ChangePasswordPage
        forced
        onDone={() => setSession({ state: "signed-in", user: { ...session.user, mustChangePassword: false } })}
      />
    );
  }

  const user = session.user;
  const signOut = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    setSession({ state: "anonymous" });
    navigate("/", true);
  };

  let page: React.ReactNode;
  const match = path.match(/^\/projects\/([^/]+)(?:\/(logs|settings))?\/?$/);
  if (projects === null) page = <div className="empty">Loading…</div>;
  else if (match) {
    const project = projects.find((p) => p.id === match[1]);
    if (!project) page = <div className="empty">This project does not exist.</div>;
    else if (match[2] === "settings") page = <ProjectsPage user={user} projects={projects} current={project} onChange={loadProjects} />;
    else page = <LogsPage key={project.id} project={project} />;
  } else if (path === "/projects") page = <ProjectsPage user={user} projects={projects} onChange={loadProjects} />;
  else if (path === "/audit" && user.role === "admin") page = <AuditPage />;
  else if (path === "/system") page = <SystemPage />;
  else if (path === "/account") page = <ChangePasswordPage onDone={() => undefined} />;
  else {
    // Home: the first project's logs, or project setup when there is none.
    const first = projects[0];
    page = <Redirect to={first ? `/projects/${first.id}/logs` : "/projects"} />;
  }

  return (
    <Layout user={user} projects={projects ?? []} path={path} onSignOut={signOut}>
      {page}
    </Layout>
  );
}
