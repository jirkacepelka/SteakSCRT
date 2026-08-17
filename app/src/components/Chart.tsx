"use client";

import { useId, useMemo, useState } from "react";

/**
 * Charts, drawn as plain SVG.
 *
 * No charting library: two forms are needed, both are a few lines of geometry, and that is
 * smaller than any dependency while leaving nothing to fight when the design changes.
 *
 * Every series is single-hue. A line chart with one series needs no legend — the panel
 * heading names it — and the validator bars carry identity in their labels rather than in
 * colour, which is what lets the page use one accent without inventing a categorical
 * palette that would then have to survive a colourblindness check.
 */

export interface Point {
  x: number;
  y: number;
}

interface LineChartProps {
  points: Point[];
  height?: number;
  formatY: (value: number) => string;
  formatX: (value: number) => string;
  /** Start the y-axis at zero rather than at the data's own floor. */
  zeroBased?: boolean;
}

export function LineChart({
  points,
  height = 190,
  formatY,
  formatX,
  zeroBased = false,
}: LineChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const gradientId = useId();

  const W = 1000;
  const H = height;
  const PAD = { top: 14, right: 8, bottom: 24, left: 54 };

  const geometry = useMemo(() => {
    if (points.length < 2) return null;

    const ys = points.map((p) => p.y);
    const rawMin = Math.min(...ys);
    const rawMax = Math.max(...ys);

    // A flat series would collapse to a zero-height band and divide by zero, so give it
    // room — but proportionally. An absolute pad put an exchange rate pinned at 1.0 on an
    // axis running to 2.0, which reads as though it might double at any moment.
    const flat = rawMax - rawMin < Math.abs(rawMax) * 1e-9;
    const pad = flat ? Math.abs(rawMax) * 0.001 || 1 : (rawMax - rawMin) * 0.12;
    // Every series here is a quantity — a balance, a supply, a rate — and none can be
    // negative. Padding a wide range downward put the axis floor below zero and invited a
    // reader to wonder what a negative exchange rate would mean.
    const min = zeroBased ? 0 : Math.max(0, rawMin - pad);
    const max = rawMax + pad;
    const span = max - min || 1;

    const xs = points.map((p) => p.x);
    const xMin = Math.min(...xs);
    const xSpan = Math.max(...xs) - xMin || 1;

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    const coords = points.map((p) => ({
      cx: PAD.left + ((p.x - xMin) / xSpan) * plotW,
      cy: PAD.top + plotH - ((p.y - min) / span) * plotH,
    }));

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

  if (!geometry) {
    return (
      <div className="empty" style={{ padding: "var(--s-8) 0" }}>
        <p className="hint">Not enough history yet — this fills in as the protocol runs.</p>
      </div>
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
          const x = ((event.clientX - box.left) / box.width) * W;
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
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="chart-fill-from" />
            <stop offset="100%" className="chart-fill-to" />
          </linearGradient>
        </defs>

        {geometry.ticks.map((tick) => (
          <g key={tick.value}>
            <line className="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={tick.y} y2={tick.y} />
            <text className="chart-axis" x={PAD.left - 10} y={tick.y + 4} textAnchor="end">
              {formatY(tick.value)}
            </text>
          </g>
        ))}

        <path d={geometry.area} fill={`url(#${gradientId})`} />
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
          <strong className="num">{formatY(active.y)}</strong>
          <span className="faint" style={{ marginLeft: 8 }}>
            {formatX(active.x)}
          </span>
        </div>
      )}
    </div>
  );
}

export interface BarDatum {
  /** Used as the key, and as the label when nothing richer is supplied. */
  label: string;
  value: number;
  display: string;
  note?: string;
  /** A label with its own structure — an identity rather than a string. */
  render?: React.ReactNode;
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
    <div className="stack" style={{ gap: "var(--s-4)" }}>
      {data.map((d) => (
        <div key={d.label}>
          <div className="row" style={{ marginBottom: 8, minHeight: 0 }}>
            {d.render ?? (
              <span className="k num" title={d.label} style={{ fontSize: 13 }}>
                {d.label}
                {d.note && <span className="faint"> · {d.note}</span>}
              </span>
            )}
            <span className="v num">{d.display}</span>
          </div>
          <svg className="chart" viewBox="0 0 1000 6" height={6} preserveAspectRatio="none">
            <rect className="chart-bar-track" x={0} y={0} width={1000} height={6} rx={3} />
            <rect
              className="chart-bar"
              x={0}
              y={0}
              width={Math.max(0, (d.value / ceiling) * 1000)}
              height={6}
              rx={3}
            />
          </svg>
        </div>
      ))}
    </div>
  );
}
