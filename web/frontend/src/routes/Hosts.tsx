import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { Page } from "../components/Page";
import { Table, Td, StatusDot } from "../components/Table";
import { ErrorBlock, Loading } from "../components/State";
import { LOST_HINT, isLost } from "../engines";

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
  const [engines, setEngines] = useState<Engine[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    // Both halves of the table matter: a swallowed engines failure used to
    // leave a header row hovering over nothing with no reason given.
    api
      .get<Usage>("/usage")
      .then(setUsage)
      .catch((e) => setError(errorText(e)));
    api
      .get<Engine[]>("/engines")
      .then(setEngines)
      .catch((e) => {
        setEngines([]);
        setError((cur) => cur || errorText(e));
      });
  }, []);

  const loading = usage === null && engines === null && !error;

  return (
    <Page title="Hosts" eyebrow="Infrastructure">
      {error && <ErrorBlock title="Couldn't read the fleet" error={error} />}
      {loading && <Loading />}
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
        {(engines ?? [])
          .filter((e) => e.name !== "main")
          .map((e) => (
            <tr key={e.name}>
              <Td>
                <StatusDot
                  tone={isLost(e.state) ? "err" : e.state === "stopped" ? "dim" : "ok"}
                />
              </Td>
              <Td mono>{e.name}</Td>
              <Td>Engine</Td>
              <Td>
                <span
                  style={isLost(e.state) ? { color: "var(--err)" } : undefined}
                  title={isLost(e.state) ? LOST_HINT : undefined}
                >
                  {e.state}
                </span>
              </Td>
              <Td>{e.resources.cpus}</Td>
            </tr>
          ))}
        {!usage && (engines ?? []).length === 0 && !loading && (
          <tr>
            <Td>{""}</Td>
            <Td>
              <span style={{ color: "var(--text-dim)" }}>
                No containers reporting — the main container answers /usage as soon as pebblesd is
                up.
              </span>
            </Td>
            <Td>{""}</Td>
            <Td>{""}</Td>
            <Td>{""}</Td>
          </tr>
        )}
      </Table>
      <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 14 }}>
        Removing an engine invalidates its credentials; it can rejoin with a fresh join token.
      </p>
    </Page>
  );
}
