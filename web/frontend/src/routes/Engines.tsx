import { useEffect, useState } from "react";
import { api } from "../api";
import { Page, AccentButton } from "../components/Page";
import { Table, Td, StatusDot } from "../components/Table";
import { LOST_HINT, engineTone, isLost } from "../engines";

interface Engine {
  name: string;
  address: string;
  state: string;
  resources: { cpus: number; memory_bytes: number };
  access?: string;
  sessions: number;
}

export function Engines() {
  const [engines, setEngines] = useState<Engine[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .get<Engine[]>("/engines")
      .then(setEngines)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  return (
    <Page title="Engines" eyebrow="Infrastructure" actions={<AccentButton>Register engine</AccentButton>}>
      {error && <p style={{ color: "var(--err)" }}>{error}</p>}
      {engines && engines.length > 0 ? (
        <Table head={["", "Engine", "State", "Sessions", "CPUs", "Access", "Address"]}>
          {engines.map((e) => (
            <tr key={e.name}>
              <Td>
                <StatusDot tone={engineTone(e.state)} />
              </Td>
              <Td>{e.name}</Td>
              <Td>
                <span
                  style={isLost(e.state) ? { color: "var(--err)" } : undefined}
                  title={isLost(e.state) ? LOST_HINT : undefined}
                >
                  {e.state}
                </span>
              </Td>
              <Td>{e.sessions}</Td>
              <Td>{e.resources.cpus}</Td>
              <Td mono>{e.access ?? "everyone"}</Td>
              <Td mono>{e.address}</Td>
            </tr>
          ))}
        </Table>
      ) : (
        <p style={{ color: "var(--text-dim)" }}>
          {engines ? "No engines registered yet." : "Loading…"}
        </p>
      )}
    </Page>
  );
}
