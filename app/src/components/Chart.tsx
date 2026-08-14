"use client";

import { useMemo, useState } from "react";

/**
 * Charts, drawn as plain SVG.
 *
 * No charting library: two forms are needed and both are a few lines of geometry, which
 * is smaller than any dependency and leaves nothing to fight when the design changes.
 *
 * Every series here is single-hue. A line chart with one series needs no legend — the
 * title names it — and the validator bars carry identity in their labels rather than in
 * colour, which is what lets the whole page use the brand's one accent without inventing
 * a categorical palette that would not survive a colourblindness check.
 */

export interface Point {
  x: number;
  y: number;
}

interface LineChartProps {
  points: Point[];
  height?: number;
  /** Rendered into the tooltip and the y-axis labels. */
  formatY: (value: number) => string;
  formatX: (value: number) => string;
  /** Start the y-axis at the data's own floor rather than zero. */
  zeroBased?: boolean;
}

export function LineChart({
  points,
  height = 200,
  formatY,
  formatX,
  zeroBased = false,
}: LineChartProps) {
  const [hover, setHover] = useState<number | null>(null);

  const W = 1000;
  const H = height;
  const PAD = { top: 12, right: 12, bottom: 22, left: 56 };

  const geometry = useMemo(() => {
    if (points.length === 0) return null;

    const ys = points.map((p) => p.y);
    const rawMin = Math.min(...ys);
    const rawMax = Math.max(...ys);

    // A flat series would collapse to a zero-height band and divide by zero, so give it
    // room — but proportionally. An absolute pad put an exchange rate pinned at 1.0 on an
    // axis running to 2.0, which reads as though it might double any moment.
    const flat = rawMax - rawMin < Math.abs(rawMax) * 1e-9;
    const pad = flat ? Math.abs(rawMax) * 0.001 || 1 : 0;
    const min = zeroBased ? 0 : rawMin - pad;
    const max = rawMax + pad;
    const span = max - min || 1;

    const xs = points.map((p) => p.x);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const xSpan = xMax - xMin || 1;

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    const at = (p: Point) => ({
      cx: PAD.left + ((p.x - xMin) / xSpan) * plotW,
      cy: PAD.top + plotH - ((p.y - min) / span) * plotH,
    });

    const coords = points.map(at);
    const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.cx},${c.cy}`).join(" ");
    const area =
      `${line} L${coords[coords.length - 1]!.cx},${PAD.top + plotH} ` +
      `L${coords[0]!.cx},${PAD.top + plotH} Z`;

    const ticks = [min, min + span / 2, max].map((value) => ({
      value,
      y: PAD.top + plotH - ((value - min) / span) * plotH,
    }));

    return { coords, line, area, ticks, plotH };
  }, [points, H, zeroBased]);

  if (!geometry || points.length < 2) {
    return (
      <p className="note" style={{ marginTop: 0 }}>
        Not enough history yet — the chart fills in as the protocol accumulates blocks.
      </p>
    );
  }

  const active = hover !== null ? points[hover] : null;
  const activeAt = hover !== null ? geometry.coords[hover] : null;

  return (
    <div className="chart-wrap">
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - box.left) / box.width;
          const x = ratio * W;
          // Nearest point wins, so the hit target is half the gap between points rather
          // than the mark itself.
          let best = 0;
          let bestGap = Infinity;
          geometry.coords.forEach((c, i) => {
            const gap = Math.abs(c.cx - x);
            if (gap < bestGap) {
              bestGap = gap;
              best = i;
            }
          });
          setHover(best);
        }}
      >
        {geometry.ticks.map((tick) => (
          <g key={tick.value}>
            <line className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={tick.y} y2={tick.y} />
            <text className="chart-axis" x={PAD.left - 8} y={tick.y + 4} textAnchor="end">
              {formatY(tick.value)}
            </text>
          </g>
        ))}

        <path className="chart-area" d={geometry.area} />
        <path className="chart-line" d={geometry.line} />

        {activeAt && (
          <>
            <line
              className="chart-crosshair"
              x1={activeAt.cx}
              x2={activeAt.cx}
              y1={PAD.top}
              y2={PAD.top + geometry.plotH}
            />
            <circle className="chart-marker" cx={activeAt.cx} cy={activeAt.cy} r={5} />
          </>
        )}

        <text className="chart-axis" x={PAD.left} y={H - 6}>
          {formatX(points[0]!.x)}
        </text>
        <text className="chart-axis" x={W - PAD.right} y={H - 6} textAnchor="end">
          {formatX(points[points.length - 1]!.x)}
        </text>
      </svg>

      {active && activeAt && (
        <div
          className="tooltip"
          style={{ left: `${(activeAt.cx / W) * 100}%`, top: `${(activeAt.cy / H) * 100}%` }}
        >
          <strong className="numeral">{formatY(active.y)}</strong>
          <br />
          <span style={{ color: "var(--ink-quiet)" }}>{formatX(active.x)}</span>
        </div>
      )}
    </div>
  );
}

export interface BarDatum {
  label: string;
  value: number;
  /** Shown to the right of the bar. */
  display: string;
  note?: string;
}

/**
 * Horizontal bars for magnitude-by-identity.
 *
 * Bars rather than a pie: comparing lengths against a shared baseline is what the eye is
 * good at, and a dozen validators would make a pie unreadable. One hue throughout, because
 * the name beside each bar is the identity — colour would be decoration carrying no
 * information.
 */
export function BarList({ data, max }: { data: BarDatum[]; max?: number }) {
  const ceiling = max ?? Math.max(...data.map((d) => d.value), 1);

  return (
    <div>
      {data.map((d) => (
        <div key={d.label} style={{ marginBottom: 14 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              fontSize: 14,
              marginBottom: 6,
            }}
          >
            <span title={d.label}>
              {d.label}
              {d.note && <span style={{ color: "var(--ink-faint)" }}> · {d.note}</span>}
            </span>
            <span className="numeral" style={{ fontWeight: 700 }}>
              {d.display}
            </span>
          </div>
          <svg className="chart" viewBox="0 0 1000 8" height={8} preserveAspectRatio="none">
            <rect className="chart-bar-track" x={0} y={0} width={1000} height={8} rx={4} />
            <rect
              className="chart-bar"
              x={0}
              y={0}
              width={Math.max(0, (d.value / ceiling) * 1000)}
              height={8}
              rx={4}
            />
          </svg>
        </div>
      ))}
    </div>
  );
}
