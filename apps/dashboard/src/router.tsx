import { useCallback, useEffect, useState } from "react";

/** A few lines of history-API routing; the dashboard has only a handful of screens. */
export function navigate(to: string, replace = false): void {
  if (to === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"](null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useLocation(): { path: string; search: URLSearchParams } {
  const read = () => ({ path: location.pathname, search: new URLSearchParams(location.search) });
  const [state, setState] = useState(read);
  useEffect(() => {
    const update = () => setState(read());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return state;
}

/** Query-string state, so filtered views can be bookmarked and shared. */
export function useQueryState(): [URLSearchParams, (next: Record<string, string | undefined>) => void] {
  const { search } = useLocation();
  const update = useCallback((next: Record<string, string | undefined>) => {
    const params = new URLSearchParams(location.search);
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === "") params.delete(key);
      else params.set(key, value);
    }
    const query = params.toString();
    navigate(`${location.pathname}${query ? `?${query}` : ""}`, true);
  }, []);
  return [search, update];
}

export function Link(props: { to: string; className?: string; children: React.ReactNode; title?: string }) {
  return (
    <a
      href={props.to}
      className={props.className}
      title={props.title}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(props.to);
      }}
    >
      {props.children}
    </a>
  );
}

/** Navigates after render (never during it). */
export function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, true), [to]);
  return null;
}
