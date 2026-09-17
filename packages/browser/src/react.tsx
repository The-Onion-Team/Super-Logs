import { Component, type ErrorInfo, type ReactNode } from "react";
import { getSuperLogs, type BrowserSuperLogs } from "./index.js";

export interface SuperLogsErrorBoundaryProps {
  children?: ReactNode;
  /** Rendered after a crash. Receives the error and a reset function. */
  fallback?: ReactNode | ((props: { error: Error; reset: () => void }) => ReactNode);
  /** Defaults to the installed logger. */
  logs?: BrowserSuperLogs;
  /** Extra fields for the report, e.g. `{ tags: { area: "auction" } }`. */
  fields?: Record<string, unknown>;
}

interface State {
  error: Error | null;
}

/** Catches render errors below it and reports them with React's component stack. */
export class SuperLogsErrorBoundary extends Component<SuperLogsErrorBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportReactError(error, info, this.props.logs, this.props.fields);
  }

  private reset = () => this.setState({ error: null });

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { fallback } = this.props;
    if (typeof fallback === "function") return fallback({ error, reset: this.reset });
    return fallback ?? null;
  }
}

/**
 * Reports an error caught by a framework boundary (e.g. Next.js `error.tsx`
 * / `global-error.tsx`, which receive the error but no component stack).
 */
export function reportReactError(
  error: unknown,
  info?: { componentStack?: string | null },
  logs: BrowserSuperLogs = getSuperLogs(),
  fields?: Record<string, unknown>,
): void {
  const withStack =
    error instanceof Error && info?.componentStack
      ? Object.assign(error, { componentStack: info.componentStack })
      : error;
  logs.captureException(withStack, { event: "react_render_error", ...fields });
}
