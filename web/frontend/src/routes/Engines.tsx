import { useEffect, useState } from "react";
import { api } from "../api";
import { Page, AccentButton } from "../components/Page";
import { Table, Td, StatusDot } from "../components/Table";

interface Engine {
  name: string;
  address: string;
  state: string;
  resources: { cpus: number; memory_bytes: number };
  access?: string;
  sessions: number;
}

function tone(state: string): "ok" | "warn" | "err" | "dim" {
  if (state.startsWith("available") || state.startsWith("in use")) return "ok";
  if (state.startsWith("draining")) return "warn";
  if (state === "stopped") return "dim";
  return "dim";
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
                <StatusDot tone={tone(e.state)} />
              </Td>
              <Td>{e.name}</Td>
              <Td>{e.state}</Td>
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
