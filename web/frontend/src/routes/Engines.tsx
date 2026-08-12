import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorText } from "../api";
import { Page, AccentButton } from "../components/Page";
import { Table, Td, StatusDot } from "../components/Table";
import { Empty, EmptyAction, ErrorBlock, Loading } from "../components/State";
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
  const nav = useNavigate();
  const [engines, setEngines] = useState<Engine[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .get<Engine[]>("/engines")
      .then(setEngines)
      .catch((e) => setError(errorText(e)));
  }, []);

  // Registering an engine *is* minting a join token — the engine container
  // trades it for membership, so the button goes where the tokens live.
  const mint = () => nav("/settings?tab=tokens");

  return (
    <Page
      title="Engines"
      eyebrow="Infrastructure"
      actions={<AccentButton onClick={mint}>Register engine</AccentButton>}
    >
      {error && <ErrorBlock title="Couldn't load engines" error={error} />}
      {!error && engines === null && <Loading />}
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
        engines !== null && (
          <Empty
            glyph="◍"
            title="No engines registered yet"
            body="Engines are the containers that run your queries. Mint a single-use join token, start an engine container with it, and it appears here."
            action={<EmptyAction onClick={mint}>Mint a join token</EmptyAction>}
          />
        )
      )}
    </Page>
  );
}
