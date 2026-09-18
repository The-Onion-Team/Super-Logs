import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LatencyBucket } from "../src/api";
import { ErrorRate, Latency } from "../src/components/charts";

/**
 * The charts place every mark at an absolute coordinate, so the things that go
 * wrong are geometric: labels off the edge, labels on top of each other, and
 * fills drawn through hours that hold no data. Rendering to markup lets us check
 * all three without a browser.
 */

const W = 720;
const H = 150;

const texts = (markup: string) =>
  [...markup.matchAll(/<text[^>]*\sx="([-\d.]+)"[^>]*\sy="([-\d.]+)"[^>]*>([^<]*)</g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
    label: m[3] ?? "",
  }));

const hours = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 8, 17, i)).toISOString());

describe("error rate chart", () => {
  const buckets = hours(24).map((start, i) => ({
    start,
    // Hours 6-9 saw no traffic at all, so they have no rate to plot.
    total: i >= 6 && i <= 9 ? 0 : 100,
    errors: i === 20 ? 45 : 2,
  }));

  it("keeps every label inside the canvas", () => {
    const markup = renderToStaticMarkup(createElement(ErrorRate, { buckets }));
    for (const text of texts(markup)) {
      expect(text.x, `"${text.label}" x`).toBeGreaterThanOrEqual(0);
      // Labels are right-anchored or short; allow the glyph run, not the canvas.
      expect(text.x, `"${text.label}" x`).toBeLessThanOrEqual(W);
      expect(text.y, `"${text.label}" y`).toBeGreaterThanOrEqual(0);
      expect(text.y, `"${text.label}" y`).toBeLessThanOrEqual(H);
    }
  });

  it("labels the peak once, and only the peak", () => {
    const markup = renderToStaticMarkup(createElement(ErrorRate, { buckets }));
    const values = texts(markup).filter((t) => t.label.endsWith("%") && t.label.includes("."));
    expect(values).toHaveLength(1);
    expect(values[0]?.label).toBe("45.0%");
  });

  it("breaks the line and the fill across hours with no events", () => {
    const markup = renderToStaticMarkup(createElement(ErrorRate, { buckets }));
    const line = /class="rate-line"[^>]*d="([^"]*)"|d="([^"]*)"[^>]*class="rate-line"/.exec(markup);
    const d = line?.[1] ?? line?.[2] ?? "";
    // Two runs of data => the line restarts once, so two "M" commands.
    expect((d.match(/M/g) ?? []).length).toBe(2);
    const area = /class="rate-area"[^>]*d="([^"]*)"|d="([^"]*)"[^>]*class="rate-area"/.exec(markup);
    const areaD = area?.[1] ?? area?.[2] ?? "";
    // And the wash is two closed shapes, never one spanning the gap.
    expect((areaD.match(/Z/g) ?? []).length).toBe(2);
  });
});

describe("latency chart", () => {
  const spread = (p50: number, p95: number, p99: number): Omit<LatencyBucket, "start"> => ({ p50, p95, p99, count: 10 });
  const buckets: LatencyBucket[] = hours(24).map((start, i) => ({ start, ...spread(80 + i, 300 + i * 4, 900 + i * 9) }));

  it("never stacks two end labels on top of each other", () => {
    const markup = renderToStaticMarkup(createElement(Latency, { buckets }));
    const ends = texts(markup)
      .filter((t) => t.x > W - 60)
      .map((t) => t.y)
      .sort((a, b) => a - b);
    for (let i = 1; i < ends.length; i++) {
      expect(Math.abs((ends[i] ?? 0) - (ends[i - 1] ?? 0)), "end labels must not collide").toBeGreaterThanOrEqual(13);
    }
  });

  it("drops the end label when two percentiles converge", () => {
    const converged: LatencyBucket[] = hours(24).map((start) => ({ start, ...spread(100, 101, 102) }));
    const markup = renderToStaticMarkup(createElement(Latency, { buckets: converged }));
    const ends = texts(markup).filter((t) => t.x > W - 60);
    // All three sit within a pixel of each other, so only one can be labelled.
    expect(ends).toHaveLength(1);
  });

  it("carries a legend so identity never rests on colour alone", () => {
    const markup = renderToStaticMarkup(createElement(Latency, { buckets }));
    expect(markup).toContain("chart-legend");
    for (const key of ["p50", "p95", "p99"]) expect(markup).toContain(key);
  });

  it("says so plainly when nothing carries a duration", () => {
    const empty: LatencyBucket[] = hours(24).map((start) => ({ start, p50: null, p95: null, p99: null, count: 0 }));
    const markup = renderToStaticMarkup(createElement(Latency, { buckets: empty }));
    expect(markup).toContain("chart-empty");
    expect(markup).not.toContain("<path");
  });
});
