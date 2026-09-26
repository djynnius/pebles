import type { CSSProperties } from "react";
import { columnsOf, type Row } from "../api";
import { cell } from "../routes/Catalog";

/*
 * Dashboard chart widgets — hand-written SVG, no chart library (NFR-03 keeps
 * the bundle air-gapped and small; spec §9 keeps layout boring).
 *
 * Sizing never measures the DOM: the caller passes the viewBox width and the
 * pixel height the tile's grid span allows, the <svg> is width:100% with that
 * explicit height, and the viewBox scales uniformly. No aspect-ratio, no
 * percentage min-heights. Every colour is a theme token set through `style`
 * (CSS variables don't resolve in SVG presentation attributes).
 */

const SERIES = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)"];
const SLICES = [...SERIES, "var(--tile-5)"];
const OTHER = "var(--grey)";

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const isNumericColumn = (rows: Row[], k: string) =>
  rows.some((r) => num(r[k]) !== null) && rows.every((r) => r[k] == null || num(r[k]) !== null);

function compact(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    n,
  );
}

/** Midnight timestamps read as dates; anything long is clipped. */
function xLabel(v: unknown): string {
  const s = cell(v);
  const d = /^(\d{4}-\d{2}-\d{2})[T ]00:00:00(?:\.0+)?(?:Z|[+-]00(?::?00)?)?$/.exec(s);
  const out = d ? d[1] : s;
  return out.length > 14 ? `${out.slice(0, 13)}…` : out;
}

const hint: CSSProperties = { fontSize: 11.5, color: "var(--text-dim)" };
const axisText: CSSProperties = {
  fill: "var(--text-faint)",
  fontSize: 10,
  fontFamily: "'IBM Plex Mono', monospace",
};

function Legend({ items }: { items: { label: string; color: string; note?: string }[] }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "4px 12px",
        fontSize: 11,
        color: "var(--text-muted)",
      }}
    >
      {items.map((it) => (
        <span
          key={it.label}
          style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 0 }}
        >
          <span
            style={{ width: 8, height: 8, borderRadius: 2, background: it.color, flex: "0 0 8px" }}
          />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {it.label}
          </span>
          {it.note && (
            <span className="mono" style={{ color: "var(--text-faint)" }}>
              {it.note}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

/* ---- line ------------------------------------------------------------------ */

/**
 * First column is the x axis, treated as categories in the order the query
 * returned them (so ORDER BY a date column gives a time series without us
 * guessing formats); each numeric column after it is one series.
 */
export function LineChart({ rows, width, height }: { rows: Row[]; width: number; height: number }) {
  const keys = columnsOf(rows);
  const xKey = keys[0];
  const series = keys.slice(1).filter((k) => isNumericColumn(rows, k)).slice(0, SERIES.length);
  if (!xKey || series.length === 0) {
    return <div style={hint}>A line needs a label column followed by at least one numeric column.</div>;
  }

  const legendH = series.length > 1 ? 22 : 0;
  const H = Math.max(60, height - legendH);
  const W = Math.max(160, width);
  const m = { l: 46, r: 12, t: 8, b: 20 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const n = rows.length;

  const all = series.flatMap((k) => rows.map((r) => num(r[k])).filter((v): v is number => v !== null));
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const x = (i: number) => (n === 1 ? m.l + pw / 2 : m.l + (i * pw) / (n - 1));
  const y = (v: number) => m.t + ph - ((v - lo) / (hi - lo)) * ph;

  const ticks = Math.min(n, Math.max(2, Math.floor(pw / 90)));
  const xIdx =
    n <= 1
      ? [0]
      : Array.from(new Set(Array.from({ length: ticks }, (_, k) => Math.round((k * (n - 1)) / (ticks - 1)))));

  const pathFor = (k: string) => {
    let d = "";
    let pen = false;
    rows.forEach((r, i) => {
      const v = num(r[k]);
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  return (
    <div>
      {legendH > 0 && (
        <div style={{ height: legendH, overflow: "hidden" }}>
          <Legend items={series.map((k, s) => ({ label: k, color: SERIES[s] }))} />
        </div>
      )}
      <svg
        width="100%"
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Line chart of ${series.join(", ")} by ${xKey}`}
        style={{ display: "block" }}
      >
        {[0, 1, 2, 3].map((g) => {
          const gy = m.t + (g * ph) / 3;
          return (
            <line
              key={g}
              x1={m.l}
              x2={W - m.r}
              y1={gy}
              y2={gy}
              style={{ stroke: "var(--border-soft)", strokeWidth: 1 }}
            />
          );
        })}
        <text x={m.l - 6} y={m.t + 4} textAnchor="end" style={axisText}>
          {compact(hi)}
        </text>
        <text x={m.l - 6} y={m.t + ph} textAnchor="end" style={axisText}>
          {compact(lo)}
        </text>
        {xIdx.map((i, k) => (
          <text
            key={i}
            x={x(i)}
            y={H - 5}
            textAnchor={xIdx.length > 1 && k === 0 ? "start" : k === xIdx.length - 1 && xIdx.length > 1 ? "end" : "middle"}
            style={axisText}
          >
            {xLabel(rows[i][xKey])}
          </text>
        ))}
        {series.map((k, s) => (
          <g key={k}>
            <path
              d={pathFor(k)}
              style={{
                fill: "none",
                stroke: SERIES[s],
                strokeWidth: 2,
                strokeLinejoin: "round",
                strokeLinecap: "round",
              }}
            />
            {n <= 40 &&
              rows.map((r, i) => {
                const v = num(r[k]);
                return v === null ? null : (
                  <circle key={i} cx={x(i)} cy={y(v)} r={2.5} style={{ fill: SERIES[s] }}>
                    <title>{`${xLabel(r[xKey])} · ${k}: ${v.toLocaleString()}`}</title>
                  </circle>
                );
              })}
          </g>
        ))}
      </svg>
    </div>
  );
}

/* ---- donut ----------------------------------------------------------------- */

function polar(cx: number, cy: number, r: number, a: number): string {
  return `${(cx + r * Math.cos(a)).toFixed(3)},${(cy + r * Math.sin(a)).toFixed(3)}`;
}

function arc(a0: number, a1: number, R: number, r: number): string {
  const c = 50;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return [
    `M${polar(c, c, R, a0)}`,
    `A${R},${R} 0 ${large} 1 ${polar(c, c, R, a1)}`,
    `L${polar(c, c, r, a1)}`,
    `A${r},${r} 0 ${large} 0 ${polar(c, c, r, a0)}`,
    "Z",
  ].join(" ");
}

/**
 * First column labels, first numeric column after it values. The six largest
 * slices keep their own colour; the rest fold into "Other". Negative values
 * can't be a share of a whole and count as zero.
 */
export function DonutChart({ rows, height }: { rows: Row[]; height: number }) {
  const keys = columnsOf(rows);
  const labelKey = keys[0];
  const valueKey = keys.find((k, i) => i > 0 && isNumericColumn(rows, k));
  if (!labelKey || !valueKey) {
    return <div style={hint}>A donut needs a label column followed by a numeric column.</div>;
  }

  const items = rows
    .map((r) => ({ label: cell(r[labelKey]), value: Math.max(0, num(r[valueKey]) ?? 0) }))
    .sort((a, b) => b.value - a.value);
  const top = items.slice(0, SLICES.length).map((it, i) => ({ ...it, color: SLICES[i] }));
  const rest = items.slice(SLICES.length).reduce((s, it) => s + it.value, 0);
  const slices = rest > 0 ? [...top, { label: "Other", value: rest, color: OTHER }] : top;
  const total = slices.reduce((s, it) => s + it.value, 0);
  if (total <= 0) return <div style={hint}>Nothing to share out — every value is zero.</div>;

  const size = Math.max(64, Math.min(height, 240));
  const R = 48;
  const r = 31;
  let a = -Math.PI / 2;
  const paths = slices
    .filter((s) => s.value > 0)
    .map((s) => {
      const sweep = (s.value / total) * Math.PI * 2;
      const a0 = a;
      a += sweep;
      // A full turn can't be one SVG arc (start == end): draw two halves.
      const d =
        sweep >= Math.PI * 2 - 1e-6
          ? `${arc(a0, a0 + Math.PI, R, r)} ${arc(a0 + Math.PI, a0 + Math.PI * 2 - 1e-4, R, r)}`
          : arc(a0, a, R, r);
      return { ...s, d };
    });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        role="img"
        aria-label={`Donut chart of ${valueKey} by ${labelKey}`}
        style={{ display: "block", flex: `0 0 ${size}px` }}
      >
        {paths.map((p, i) => (
          <path key={i} d={p.d} style={{ fill: p.color, stroke: "var(--surface)", strokeWidth: 0.6 }}>
            <title>{`${p.label}: ${p.value.toLocaleString()} (${((p.value / total) * 100).toFixed(1)}%)`}</title>
          </path>
        ))}
        <text
          x={50}
          y={52}
          textAnchor="middle"
          style={{ fill: "var(--text)", fontSize: 13, fontWeight: 600 }}
        >
          {compact(total)}
        </text>
        <text x={50} y={62} textAnchor="middle" style={{ fill: "var(--text-faint)", fontSize: 6 }}>
          total
        </text>
      </svg>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
        {slices.map((s, i) => (
          <div
            key={i}
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, minWidth: 0 }}
          >
            <span
              style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flex: "0 0 8px" }}
            />
            <span
              title={s.label}
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "var(--text-mid)",
              }}
            >
              {s.label}
            </span>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {((s.value / total) * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
