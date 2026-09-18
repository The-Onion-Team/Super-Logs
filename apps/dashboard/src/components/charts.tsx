import type { LatencyBucket } from "../api";

/**
 * Shared geometry. Charts are drawn in a fixed user-space box and scaled by CSS;
 * strokes carry `vector-effect="non-scaling-stroke"` so a 2px line stays 2px at
 * any width. No chart library: an SVG path is cheaper than 500 KB of Recharts.
 */
const W = 720;
const H = 150;
const PAD = { top: 12, right: 44, bottom: 18, left: 40 };
const PLOT = { w: W - PAD.left - PAD.right, h: H - PAD.top - PAD.bottom };

const hourLabel = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });

function x(i: number, n: number): number {
  return PAD.left + (n <= 1 ? PLOT.w / 2 : (i / (n - 1)) * PLOT.w);
}

function y(value: number, max: number): number {
  return PAD.top + PLOT.h - (max <= 0 ? 0 : (value / max) * PLOT.h);
}

/** Clean axis ticks: 0, then round steps up to the max. */
function ticks(max: number, count = 3): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? magnitude * 10;
  const out: number[] = [];
  for (let v = 0; v <= max + step / 2; v += step) out.push(v);
  return out;
}

/** The runs of consecutive non-null points; a gap must not be drawn through. */
function segments(values: (number | null)[]): { i: number; value: number }[][] {
  const runs: { i: number; value: number }[][] = [];
  let run: { i: number; value: number }[] = [];
  values.forEach((value, i) => {
    if (value == null) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push({ i, value });
    }
  });
  if (run.length) runs.push(run);
  return runs;
}

/** A path with gaps: null values break the line rather than reading as zero. */
function linePath(values: (number | null)[], max: number): string {
  return segments(values)
    .map((run) => run.map((p, k) => `${k ? "L" : "M"}${x(p.i, values.length).toFixed(1)} ${y(p.value, max).toFixed(1)}`).join(""))
    .join("");
}

/** One closed wash per run, so the fill never spans an hour that had no data. */
function areaPath(values: (number | null)[], max: number): string {
  const base = y(0, max).toFixed(1);
  return segments(values)
    .filter((run) => run.length > 1)
    .map((run) => {
      const line = run.map((p, k) => `${k ? "L" : "M"}${x(p.i, values.length).toFixed(1)} ${y(p.value, max).toFixed(1)}`).join("");
      const first = run[0];
      const last = run[run.length - 1];
      if (!first || !last) return "";
      return `${line}L${x(last.i, values.length).toFixed(1)} ${base}L${x(first.i, values.length).toFixed(1)} ${base}Z`;
    })
    .join("");
}

function Grid({ max, unit }: { max: number; unit: (v: number) => string }) {
  return (
    <g className="chart-grid" aria-hidden="true">
      {ticks(max).map((tick) => (
        <g key={tick}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(tick, max)} y2={y(tick, max)} vectorEffect="non-scaling-stroke" />
          <text x={PAD.left - 6} y={y(tick, max) + 3} textAnchor="end">
            {unit(tick)}
          </text>
        </g>
      ))}
    </g>
  );
}

/** Per-bucket hover: a crosshair plus the native tooltip, with no JS state. */
function HoverBands({ labels, n }: { labels: string[]; n: number }) {
  const band = PLOT.w / Math.max(1, n - 1);
  return (
    <g className="chart-hover">
      {labels.map((label, i) => (
        <g key={i}>
          <title>{label}</title>
          <line
            className="crosshair"
            x1={x(i, n)}
            x2={x(i, n)}
            y1={PAD.top}
            y2={PAD.top + PLOT.h}
            vectorEffect="non-scaling-stroke"
          />
          {/* Clamped, so the end bands do not reach out over the axis labels. */}
          <rect
            x={Math.max(x(i, n) - band / 2, PAD.left)}
            width={Math.min(band, W - PAD.right - Math.max(x(i, n) - band / 2, PAD.left))}
            y={0}
            height={H}
            fill="transparent"
          />
        </g>
      ))}
    </g>
  );
}

/**
 * Error rate over time — errors as a share of all events.
 * Deliberately a separate chart from the volume histogram: plotting a percentage
 * and a count on one pair of axes is a dual-axis chart, which invents a
 * correlation the data does not have.
 */
export function ErrorRate({ buckets }: { buckets: { start: string; errors: number; total: number }[] }) {
  // An hour with no traffic has no rate — a gap, not a zero.
  const rates = buckets.map((b) => (b.total > 0 ? (b.errors / b.total) * 100 : null));
  const peak = Math.max(1, ...rates.filter((r): r is number => r != null));
  const max = ticks(peak).at(-1) ?? 1;
  const path = linePath(rates, max);
  const area = areaPath(rates, max);
  let peakPoint: { at: number; rate: number } | null = null;
  for (let i = 0; i < rates.length; i++) {
    const rate = rates[i];
    if (rate != null && (peakPoint === null || rate > peakPoint.rate)) peakPoint = { at: i, rate };
  }

  return (
    <figure className="chart">
      <figcaption>
        Error rate <span className="muted">· errors as a share of events</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="Error rate per hour over the window">
        <Grid max={max} unit={(v) => `${Math.round(v)}%`} />
        {area && <path d={area} className="rate-area" />}
        <path d={path} className="rate-line" fill="none" vectorEffect="non-scaling-stroke" />
        {/* Label the extreme only — a number on every point goes unread. */}
        {peakPoint && (
          <>
            <circle cx={x(peakPoint.at, rates.length)} cy={y(peakPoint.rate, max)} r={4} className="rate-dot" />
            <text
              x={Math.min(x(peakPoint.at, rates.length) + 8, W - PAD.right)}
              y={Math.max(y(peakPoint.rate, max) - 7, PAD.top + 8)}
              className="chart-label"
            >
              {peakPoint.rate.toFixed(1)}%
            </text>
          </>
        )}
        <HoverBands
          n={buckets.length}
          labels={buckets.map(
            (b, i) =>
              `${hourLabel.format(new Date(b.start))} · ${rates[i] == null ? "no events" : `${rates[i]?.toFixed(1)}% (${b.errors} of ${b.total})`}`,
          )}
        />
      </svg>
    </figure>
  );
}

const SERIES = [
  { key: "p50", label: "p50" },
  { key: "p95", label: "p95" },
  { key: "p99", label: "p99" },
] as const;

function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s` : `${Math.round(value)}ms`;
}

/**
 * Request latency percentiles. One hue in three ordered steps — p50/p95/p99 is an
 * ordered scale, so a sequential ramp is the honest encoding; status colors would
 * imply a severity the numbers do not carry on their own.
 */
export function Latency({ buckets }: { buckets: LatencyBucket[] }) {
  const series = SERIES.map((s) => ({ ...s, values: buckets.map((b) => b[s.key]) }));
  const peak = Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => v != null)));
  const max = ticks(peak).at(-1) ?? 1;
  const timed = buckets.some((b) => b.count > 0);

  // Direct-label the series that separate at the right edge; the legend carries
  // the rest. Stacking collided labels detaches them from their lines.
  let lastLabelY = Number.POSITIVE_INFINITY;
  const ends: { key: string; value: number }[] = [];
  for (const s of series) {
    const last = [...s.values].reverse().find((v): v is number => v != null);
    if (last != null) ends.push({ key: s.key, value: last });
  }
  const endLabels = ends
    .sort((a, b) => b.value - a.value)
    .filter((s) => {
      const at = y(s.value, max);
      if (at > lastLabelY - 13) return false;
      lastLabelY = at;
      return true;
    });

  return (
    <figure className="chart">
      <figcaption>
        Latency <span className="muted">· percentiles of request duration</span>
      </figcaption>
      {!timed ? (
        <p className="chart-empty">No events in this window carry a duration. Send `durationMs` to see percentiles.</p>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label="Latency percentiles per hour">
            <Grid max={max} unit={ms} />
            {series.map((s) => (
              <path
                key={s.key}
                d={linePath(s.values, max)}
                className={`lat-line lat-${s.key}`}
                fill="none"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {endLabels.map((s) => (
              <text key={s.key} x={W - PAD.right + 6} y={y(s.value, max) + 3} className="chart-label">
                {ms(s.value)}
              </text>
            ))}
            <HoverBands
              n={buckets.length}
              labels={buckets.map((b) =>
                b.count === 0
                  ? `${hourLabel.format(new Date(b.start))} · no timed events`
                  : `${hourLabel.format(new Date(b.start))} · p50 ${ms(b.p50 ?? 0)} · p95 ${ms(b.p95 ?? 0)} · p99 ${ms(b.p99 ?? 0)} · ${b.count} events`,
              )}
            />
          </svg>
          {/* Identity never rests on color alone. */}
          <ul className="chart-legend">
            {SERIES.map((s) => (
              <li key={s.key}>
                <span className={`key lat-${s.key}`} aria-hidden="true" />
                {s.label}
              </li>
            ))}
          </ul>
        </>
      )}
    </figure>
  );
}

/** A 24-point trend for one error group, in the de-emphasis hue. */
export function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const width = 100;
  const height = 24;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const path = values.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)} ${(height - (v / max) * (height - 2) - 1).toFixed(1)}`).join("");
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Peak ${max} per hour`}>
      <path d={path} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
