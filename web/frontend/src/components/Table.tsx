import type { ReactNode } from "react";

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        overflow: "hidden",
      }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: "left",
                  background: "var(--surface-alt)",
                  borderBottom: "1px solid var(--border)",
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: "0.5px",
                  textTransform: "uppercase",
                  color: "var(--text-faint)",
                  padding: "10px 16px",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <td
      className={mono ? "mono" : undefined}
      style={{
        padding: "11px 16px",
        borderBottom: "1px solid var(--border-soft)",
        fontSize: mono ? 12.5 : 13,
      }}
    >
      {children}
    </td>
  );
}

export function StatusDot({ tone }: { tone: "ok" | "warn" | "err" | "dim" }) {
  const color = { ok: "var(--ok)", warn: "var(--warn)", err: "var(--err)", dim: "var(--text-dim)" }[
    tone
  ];
  return (
    <span
      style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: color }}
    />
  );
}
