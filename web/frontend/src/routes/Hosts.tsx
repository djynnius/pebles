import { useEffect, useState } from "react";
import { api } from "../api";
import { Page } from "../components/Page";
import { Table, Td, StatusDot } from "../components/Table";

interface Engine {
  name: string;
  address: string;
  state: string;
  resources: { cpus: number };
}
interface Usage {
  hostname: string;
  cpus: number;
}

export function Hosts() {
  const [engines, setEngines] = useState<Engine[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.get<Usage>("/usage").then(setUsage).catch((e) => setError(String(e.message ?? e)));
    api.get<Engine[]>("/engines").then(setEngines).catch(() => {});
  }, []);

  return (
    <Page title="Hosts" eyebrow="Infrastructure">
      {error && <p style={{ color: "var(--err)" }}>{error}</p>}
      <Table head={["", "Container", "Role", "State", "CPUs"]}>
        {usage && (
          <tr>
            <Td>
              <StatusDot tone="ok" />
            </Td>
            <Td mono>{usage.hostname}</Td>
            <Td>
              <strong style={{ color: "var(--accent)" }}>Main</strong>
            </Td>
            <Td>running</Td>
            <Td>{usage.cpus}</Td>
          </tr>
        )}
        {engines
          .filter((e) => e.name !== "main")
          .map((e) => (
            <tr key={e.name}>
              <Td>
                <StatusDot tone={e.state === "stopped" ? "dim" : "ok"} />
              </Td>
              <Td mono>{e.name}</Td>
              <Td>Engine</Td>
              <Td>{e.state}</Td>
              <Td>{e.resources.cpus}</Td>
            </tr>
          ))}
      </Table>
      <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 14 }}>
        Removing an engine invalidates its credentials; it can rejoin with a fresh join token.
      </p>
    </Page>
  );
}
