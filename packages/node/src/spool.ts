import { appendFileSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import type { SuperLogsEvent } from "@super-logs/shared";

/** A crash spool never grows past this; later crashes are simply not recorded. */
const MAX_SPOOL_BYTES = 256 * 1024;

export function writeSpool(file: string, event: SuperLogsEvent): void {
  try {
    if (statSync(file).size > MAX_SPOOL_BYTES) return;
  } catch {
    /* no spool yet */
  }
  appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

/** Reads and removes the spool. Unparseable lines are skipped. */
export function readSpool(file: string): SuperLogsEvent[] {
  const claimed = `${file}.${process.pid}.sending`;
  try {
    renameSync(file, claimed);
  } catch {
    return [];
  }
  try {
    const events: SuperLogsEvent[] = [];
    for (const line of readFileSync(claimed, "utf8").split("\n").slice(0, 200)) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as SuperLogsEvent);
      } catch {
        /* torn write during a crash */
      }
    }
    return events;
  } catch {
    return [];
  } finally {
    rmSync(claimed, { force: true });
  }
}
