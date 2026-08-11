import { useEffect, useState } from "react";
import { api, type User } from "../api";
import { NkoyoAvatar } from "../components/Avatar";
import { Card } from "../components/Page";

interface Usage {
  cpus: number;
  mem_total_bytes: number;
  mem_available_bytes: number;
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

export function Home({ user }: { user: User }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [engines, setEngines] = useState<number | null>(null);
  useEffect(() => {
    api.get<Usage>("/usage").then(setUsage).catch(() => {});
    api
      .get<{ name: string }[]>("/engines")
      .then((e) => setEngines(e.length))
      .catch(() => {});
  }, []);

  const memUsedGb = usage
    ? ((usage.mem_total_bytes - usage.mem_available_bytes) / 1024 ** 3).toFixed(1)
    : "—";

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "34px 40px 60px" }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.8px",
          textTransform: "uppercase",
          color: "var(--text-faint)",
          marginBottom: 6,
        }}
      >
        {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
      </div>
      <h1 style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.5px", marginBottom: 24 }}>
        {greeting()}, {user.username}
      </h1>

      {/* KPI row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 12, marginBottom: 22 }}>
        <Kpi label="Engines running" value={engines != null ? String(engines) : "—"} qualifier="registered" />
        <Kpi label="CPUs" value={usage ? String(usage.cpus) : "—"} qualifier="this host" />
        <Kpi label="Memory in use" value={`${memUsedGb} GB`} qualifier="this host" />
        {/* the deliberately-inverted licence tile */}
        <div
          style={{
            background: "var(--deep-soft)",
            border: "1px solid var(--deep-soft)",
            color: "var(--deep-text)",
            borderRadius: 14,
            padding: 16,
          }}
        >
          <div style={{ fontSize: 11, letterSpacing: "0.7px", textTransform: "uppercase", color: "var(--accent)", minHeight: 30 }}>
            Licence cost
          </div>
          <div style={{ fontSize: 26, fontWeight: 600 }}>
            $0 <span style={{ fontSize: 13, color: "var(--deep-muted)" }}>/ month</span>
          </div>
        </div>
      </div>

      {/* Nkoyo ask bar */}
      <Card style={{ display: "flex", alignItems: "center", gap: 12, padding: 14, marginBottom: 22 }}>
        <NkoyoAvatar size={28} />
        <input
          placeholder="Ask Nkoyo about your data…"
          style={{
            flex: 1,
            border: "none",
            background: "transparent",
            color: "var(--text)",
            fontSize: 14,
            outline: "none",
          }}
        />
        <button
          style={{
            background: "var(--deep-soft)",
            color: "var(--deep-text)",
            border: "none",
            borderRadius: 11,
            fontWeight: 600,
            fontSize: 13,
            padding: "8px 16px",
          }}
        >
          Ask
        </button>
      </Card>

      <Card style={{ overflow: "hidden" }}>
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--border-soft)", fontWeight: 600 }}>
          Recents
        </div>
        <div style={{ padding: 18, color: "var(--text-dim)", fontSize: 13 }}>
          Your recent notebooks, queries, and dashboards will appear here.
        </div>
      </Card>
    </div>
  );
}

function Kpi({ label, value, qualifier }: { label: string; value: string; qualifier: string }) {
  return (
    <Card style={{ padding: 16 }}>
      <div style={{ fontSize: 11, letterSpacing: "0.7px", textTransform: "uppercase", color: "var(--text-faint)", minHeight: 30 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 600 }}>
        {value} <span style={{ fontSize: 13, color: "var(--text-dim)" }}>{qualifier}</span>
      </div>
    </Card>
  );
}
