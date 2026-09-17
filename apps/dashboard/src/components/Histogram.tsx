/** Hourly events for the last day: grey bars for all events, red overlay for errors. */
export function Histogram({ buckets }: { buckets: { start: string; errors: number; total: number }[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const width = 100 / Math.max(1, buckets.length);
  const hour = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <svg className="histogram" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="Events per hour, last 24 hours">
      {buckets.map((b, i) => {
        const total = (b.total / max) * 38;
        const errors = (b.errors / max) * 38;
        return (
          <g key={b.start}>
            <title>{`${hour.format(new Date(b.start))} · ${b.total} events, ${b.errors} errors`}</title>
            <rect x={i * width + 0.15} width={width - 0.3} y={40 - total} height={total} className="bar-total" />
            {b.errors > 0 && <rect x={i * width + 0.15} width={width - 0.3} y={40 - errors} height={Math.max(errors, 1)} className="bar-errors" />}
            {/* Full-height hit area for the tooltip. */}
            <rect x={i * width} width={width} y={0} height={40} fill="transparent" />
          </g>
        );
      })}
    </svg>
  );
}
