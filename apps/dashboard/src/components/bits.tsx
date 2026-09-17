import { useEffect, useState } from "react";
import type { Level } from "../api";

export const LEVEL_ORDER: Level[] = ["debug", "info", "warning", "error", "critical"];

/** The Super-Logs mark: an "S" traced from the browser (blue) to the server error (red). */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="4 4 24 24" aria-hidden="true">
      <path
        d="M22 8H13a4 4 0 0 0 0 8h6a4 4 0 0 1 0 8H10"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="22" cy="8" r="3.3" className="brand-mark-start" />
      <circle cx="10" cy="24" r="3.3" className="brand-mark-end" />
    </svg>
  );
}

export function LevelBadge({ level }: { level: Level }) {
  return <span className={`level level-${level}`}>{level === "warning" ? "warn" : level === "critical" ? "crit" : level}</span>;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

/** Time of day for today, date + time otherwise. */
export function Time({ iso }: { iso: string }) {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return (
    <time dateTime={iso} title={fullFormat.format(date)}>
      {!today && <span className="muted">{dateFormat.format(date)} </span>}
      {timeFormat.format(date)}
      <span className="muted">.{ms}</span>
    </time>
  );
}

export function relative(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="ghost small"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => setCopied(true));
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function ErrorNote({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p className="error-note" role="alert">
      {message}
    </p>
  );
}
