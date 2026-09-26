import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { Page, Card } from "../components/Page";
import { ErrorBlock, Loading } from "../components/State";

interface Disk {
  mount: string;
  total_bytes: number;
  free_bytes: number;
}
interface Usage {
  hostname: string;
  cpus: number;
  load_1: number;
  load_5: number;
  load_15: number;
  mem_total_bytes: number;
  mem_available_bytes: number;
  disks: Disk[];
}

const gb = (b: number) => (b / 1024 ** 3).toFixed(1);

export function Usage() {
  const [u, setU] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .get<Usage>("/usage")
      .then(setU)
      .catch((e) => setError(errorText(e)));
  }, []);

  return (
    <Page title="Resource usage" eyebrow="Admin">
      <p style={{ color: "var(--text-dim)", marginBottom: 18, marginTop: -8 }}>
        What your own hardware is doing. No credits, no metering, no invoice.
      </p>
      {error && <ErrorBlock title="Couldn't read host usage" error={error} />}
      {u ? (
        <Card style={{ overflow: "hidden" }}>
          <Row label="Host" value={<code>{u.hostname}</code>} />
          <Row label="CPUs" value={String(u.cpus)} />
          <Row label="Load (1 / 5 / 15 min)" value={`${u.load_1} · ${u.load_5} · ${u.load_15}`} />
          <Bar
            label="Memory"
            used={u.mem_total_bytes - u.mem_available_bytes}
            total={u.mem_total_bytes}
          />
          {u.disks.map((d) => (
            <Bar
              key={d.mount}
              label={`Disk ${d.mount}`}
              used={d.total_bytes - d.free_bytes}
              total={d.total_bytes}
            />
          ))}
        </Card>
      ) : (
        !error && <Loading />
      )}
    </Page>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        padding: "12px 18px",
        borderBottom: "1px solid var(--border-soft)",
        fontSize: "var(--fs-base)",
      }}
    >
      <span style={{ width: 200, color: "var(--text-muted)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Bar({ label, used, total }: { label: string; used: number; total: number }) {
  const pct = total ? Math.min(100, (100 * used) / total) : 0;
  return (
    <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border-soft)" }}>
      <div style={{ display: "flex", fontSize: "var(--fs-base)", marginBottom: 6 }}>
        <span style={{ width: 200, color: "var(--text-muted)" }}>{label}</span>
        <span>
          {gb(used)} GB used of {gb(total)} GB
        </span>
      </div>
      <div style={{ height: 8, background: "var(--track)", borderRadius: 4, overflow: "hidden" }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: pct > 75 ? "var(--viz-2)" : "var(--viz-1)",
          }}
        />
      </div>
    </div>
  );
}
