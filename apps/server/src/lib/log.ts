/** The server's own logs: one JSON line per entry on stdout/stderr. */
const RANK = { debug: 10, info: 20, warning: 30, error: 40 } as const;
type Level = keyof typeof RANK;

let min: number = RANK.info;

export function setLogLevel(level: Level): void {
  min = RANK[level];
}

function write(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (RANK[level] < min) return;
  const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...fields }, (_key, value) =>
    value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value,
  );
  (level === "error" || level === "warning" ? process.stderr : process.stdout).write(`${line}\n`);
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
  warning: (message: string, fields?: Record<string, unknown>) => write("warning", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
};
