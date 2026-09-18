import type { ErrorGroup } from "../api";
import { LevelBadge, relative } from "./bits";
import { Sparkline } from "./charts";

/**
 * What is broken, in priority order. Deliberately a table rather than a chart:
 * past a handful of classes, colour stops separating them and rank is the thing
 * the reader actually wants.
 */
export function ErrorGroups({ groups, onSelect }: { groups: ErrorGroup[]; onSelect: (fingerprint: string) => void }) {
  if (groups.length === 0) return null;
  const loudest = Math.max(...groups.map((group) => group.count));

  return (
    <section className="groups" aria-label="Top error groups">
      <h2>
        Top errors <span className="muted">· grouped by fingerprint</span>
      </h2>
      <table className="group-table">
        <thead>
          <tr>
            <th className="col-level">Level</th>
            <th>Error</th>
            <th className="col-trend">Trend</th>
            <th className="col-count">Events</th>
            <th className="col-seen">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.fingerprint} onClick={() => onSelect(group.fingerprint)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(group.fingerprint)}>
              <td className="col-level">
                <LevelBadge level={group.level} />
              </td>
              <td className="col-error">
                <strong>{group.title}</strong>
                {group.message && <span className="group-message">{group.message}</span>}
                <span className="group-meta">
                  {group.service && <span className="tag">{group.service}</span>}
                  {group.route && <span className="mono muted">{group.route}</span>}
                  <span className="muted">first seen {relative(group.firstSeen)}</span>
                </span>
              </td>
              <td className="col-trend">
                <Sparkline values={group.spark} />
              </td>
              <td className="col-count">
                <strong>{group.count.toLocaleString()}</strong>
                {/* A meter, not a second number: share of the loudest group. */}
                <span className="group-bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(2, (group.count / loudest) * 100)}%` }} />
                </span>
              </td>
              <td className="col-seen muted">{relative(group.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
