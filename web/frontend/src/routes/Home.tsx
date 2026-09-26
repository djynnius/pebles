import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorText, type User } from "../api";
import { NkoyoAvatar } from "../components/Avatar";
import { Card } from "../components/Page";
import { ErrorBlock, Loading } from "../components/State";
import { KIND_GLYPH, recentPath, relativeTime, type Recent } from "../recents";

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
  const nav = useNavigate();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [engines, setEngines] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [ask, setAsk] = useState("");
  const [recents, setRecents] = useState<Recent[] | null>(null);
  const [recentsError, setRecentsError] = useState("");

  useEffect(() => {
    // Both feed the KPI row. Swallowing a failure here left four em-dashes on
    // screen with no reason given — say why the numbers are missing instead.
    api
      .get<Usage>("/usage")
      .then(setUsage)
      .catch((e) => setError(errorText(e)));
    api
      .get<{ name: string }[]>("/engines")
      .then((e) => setEngines(e.length))
      .catch((e) => setError((cur) => cur || errorText(e)));
    api
      .get<Recent[]>("/recents")
      .then(setRecents)
      .catch((e) => {
        setRecents([]);
        setRecentsError(errorText(e));
      });
  }, []);

  /** Hand the draft to Nkoyo rather than sending it — the model call is hers. */
  const askNkoyo = () => nav("/nkoyo", { state: { prompt: ask.trim() } });

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

      {error && (
        <ErrorBlock
          title="Some of this page couldn't load"
          error={error}
          style={{ marginBottom: 22 }}
        />
      )}

      {/* KPI row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 12, marginBottom: 22 }}>
        <Kpi label="Engines" value={engines != null ? String(engines) : "—"} qualifier="registered" />
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
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") askNkoyo();
          }}
          placeholder="Ask Nkoyo about your data…"
          aria-label="Ask Nkoyo about your data"
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
          type="button"
          onClick={askNkoyo}
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
        {recentsError ? (
          <ErrorBlock
            title="Couldn't load your recents"
            error={recentsError}
            style={{ margin: 14 }}
          />
        ) : recents === null ? (
          <Loading style={{ padding: 18 }} />
        ) : recents.length === 0 ? (
          <div style={{ padding: 18, color: "var(--text-dim)", fontSize: 13 }}>
            Your recent notebooks, queries, and dashboards will appear here.
          </div>
        ) : (
          <div>
            {recents.map((r, i) => (
              <RecentRow
                key={`${r.kind}:${r.catalog ?? ""}:${r.name}`}
                item={r}
                first={i === 0}
                onOpen={() => nav(recentPath(r))}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

const KIND_NAME: Record<Recent["kind"], string> = {
  notebook: "Notebook",
  dashboard: "Dashboard",
  query: "Query",
  table: "Table",
  job: "Job",
};

function RecentRow({ item, first, onOpen }: { item: Recent; first: boolean; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Open ${KIND_NAME[item.kind].toLowerCase()} ${item.name}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        textAlign: "left",
        border: "none",
        borderTop: first ? "none" : "1px solid var(--border-soft)",
        background: hover ? "var(--hover)" : "transparent",
        padding: "10px 18px",
        color: "var(--text)",
        fontSize: 13,
      }}
    >
      <span
        aria-hidden="true"
        style={{ width: 20, textAlign: "center", color: "var(--text-faint)", flexShrink: 0 }}
      >
        {KIND_GLYPH[item.kind]}
      </span>
      <span
        className="mono"
        style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
      >
        {item.name}
      </span>
      {item.catalog && (
        <span
          className="mono"
          style={{
            fontSize: 11,
            color: "var(--accent-deep)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "1px 7px",
            flexShrink: 0,
          }}
        >
          {item.catalog}
        </span>
      )}
      <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--text-dim)", flexShrink: 0 }}>
        {relativeTime(item.at)}
      </span>
      <span style={{ width: 72, textAlign: "right", fontSize: 11.5, color: "var(--text-faint)", flexShrink: 0 }}>
        {KIND_NAME[item.kind]}
      </span>
    </button>
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
