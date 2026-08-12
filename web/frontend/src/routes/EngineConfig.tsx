import { useEffect, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Switch } from "../components/Page";

/*
 * /engineconfig — one engine's detail (spec §5 "engineconfig"). Everything the
 * server actually owns is read-only here: an engine's limits come from its
 * environment at container start, not from a form. The two switches are local
 * intent, and the page says so rather than faking a control that does nothing.
 */

interface Engine {
  name: string;
  address: string;
  state: string;
  sessions: number;
  resources: { cpus: number; memory_bytes: number };
}

interface EnginePrefs {
  accepting: boolean;
  dedicated: boolean;
}

const PREFS_KEY = "pebbles.engineprefs.v1";
const DEFAULTS: EnginePrefs = { accepting: true, dedicated: false };

function loadPrefs(name: string): EnginePrefs {
  try {
    const all = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    const one = all?.[name];
    if (one && typeof one === "object") {
      return { accepting: one.accepting !== false, dedicated: Boolean(one.dedicated) };
    }
  } catch {
    /* corrupt storage is not worth a crash */
  }
  return { ...DEFAULTS };
}

function savePrefs(name: string, prefs: EnginePrefs) {
  try {
    const all = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    all[name] = prefs;
    localStorage.setItem(PREFS_KEY, JSON.stringify(all));
  } catch {
    /* cosmetic preference — keep going */
  }
}

const gb = (b: number) => (b / 1024 ** 3).toFixed(1);

export function EngineConfig() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const wanted = params.get("engine");
  const [engines, setEngines] = useState<Engine[] | null>(null);
  const [prefs, setPrefs] = useState<EnginePrefs>(DEFAULTS);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get<Engine[]>("/engines")
      .then(setEngines)
      .catch((e) => {
        setError(String(e.message ?? e));
        setEngines([]);
      });
  }, []);

  const engine = (engines ?? []).find((e) => e.name === wanted) ?? (engines ?? [])[0];

  useEffect(() => {
    if (engine) setPrefs(loadPrefs(engine.name));
  }, [engine]);

  const toggle = (key: keyof EnginePrefs) => {
    if (!engine) return;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    savePrefs(engine.name, next);
  };

  const deregister = () => {
    if (!engine) return;
    if (!confirm(`Deregister ${engine.name}? Its credentials stop working immediately.`)) return;
    api
      .del(`/engines/${encodeURIComponent(engine.name)}`)
      .then(() => nav("/engines"))
      .catch((e) => setError(String(e.message ?? e)));
  };

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "34px 40px 60px" }}>
      <div className="mono" style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 8 }}>
        <button type="button" onClick={() => nav("/engines")} style={crumbBtn}>
          ‹ Engines
        </button>
      </div>

      {error && <p style={{ color: "var(--err)", fontSize: 12.5, marginBottom: 12 }}>{error}</p>}

      {!engine ? (
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
          {engines ? "No engines registered yet." : "Loading…"}
        </p>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <h1 style={{ fontSize: 25, fontWeight: 600, letterSpacing: "-0.5px" }}>{engine.name}</h1>
            {engines && engines.length > 1 && (
              <select
                value={engine.name}
                onChange={(e) => setParams({ engine: e.target.value }, { replace: true })}
                className="mono"
                style={{
                  padding: "5px 10px",
                  borderRadius: 20,
                  border: "1px solid var(--border)",
                  background: "var(--surface-alt)",
                  color: "var(--accent-deep)",
                  fontSize: 11.5,
                }}
              >
                {engines.map((e) => (
                  <option key={e.name} value={e.name}>
                    {e.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div style={{ ...card, marginTop: 20, overflow: "hidden" }}>
            <Row label="Address" value={engine.address} mono />
            <Row label="State" value={engine.state} />
            <Row label="Sessions" value={String(engine.sessions)} />
            <Row label="CPUs" value={String(engine.resources.cpus)} />
            <Row
              label="Memory"
              value={`${gb(engine.resources.memory_bytes)} GB`}
              last
            />
          </div>

          <h2 style={{ fontSize: 16, fontWeight: 600, margin: "24px 0 12px" }}>Session policy</h2>
          <div style={{ ...card, padding: 18, display: "grid", gap: 12 }}>
            <Switch
              label="Accept new sessions"
              on={prefs.accepting}
              onToggle={() => toggle("accepting")}
            />
            <Switch
              label="Allow dedicated sessions"
              on={prefs.dedicated}
              onToggle={() => toggle("dedicated")}
            />
            <p style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.7 }}>
              These two are remembered in this browser only. Real per-engine limits are set by the
              engine container's environment —{" "}
              <code>PEBBLES_ENGINE_MEMORY_BYTES</code>, <code>PEBBLES_SESSION_MEMORY_BYTES</code> —
              and take effect at start. Contention on a busy engine resolves by draining, never by
              refusing or preempting a session.
            </p>
          </div>

          <h2 style={{ fontSize: 16, fontWeight: 600, margin: "24px 0 12px" }}>Danger zone</h2>
          <div
            style={{
              ...card,
              padding: 18,
              borderColor: "var(--err)",
              display: "flex",
              alignItems: "center",
              gap: 14,
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: 1, minWidth: 240, fontSize: 12.5, color: "var(--text-mid)" }}>
              Deregistering invalidates this engine's credentials. It can rejoin later with a fresh
              join token.
            </div>
            <button
              type="button"
              onClick={deregister}
              style={{
                background: "var(--surface)",
                color: "var(--err)",
                border: "1px solid var(--err)",
                borderRadius: 11,
                fontWeight: 600,
                fontSize: 12.5,
                padding: "8px 16px",
              }}
            >
              Deregister engine
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  last,
}: {
  label: string;
  value: string;
  mono?: boolean;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 16,
        padding: "12px 18px",
        borderBottom: last ? "none" : "1px solid var(--border-soft)",
        fontSize: 13,
      }}
    >
      <span style={{ width: 180, color: "var(--text-muted)" }}>{label}</span>
      <span className={mono ? "mono" : undefined} style={{ fontSize: mono ? 12.5 : 13 }}>
        {value}
      </span>
    </div>
  );
}

const card: CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 14,
};

const crumbBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  fontSize: 11.5,
  color: "var(--text-dim)",
};
