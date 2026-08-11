import { useEffect, useState } from "react";
import { api } from "../api";
import { Page } from "../components/Page";
import { Table, Td } from "../components/Table";

interface Group {
  name: string;
  gid: number;
  members: string[];
}

export function Groups() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .get<Group[]>("/groups")
      .then(setGroups)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  return (
    <Page title="Groups" eyebrow="Admin">
      <p style={{ color: "var(--text-dim)", marginTop: -8, marginBottom: 18 }}>
        All grants target groups — a "user only" grant uses their personal primary group.
      </p>
      {error && <p style={{ color: "var(--err)" }}>{error}</p>}
      {groups && groups.length > 0 ? (
        <Table head={["Group", "gid", "Members"]}>
          {groups.map((g) => (
            <tr key={g.name}>
              <Td>{g.name}</Td>
              <Td mono>{g.gid}</Td>
              <Td>{g.members.length ? g.members.join(", ") : "—"}</Td>
            </tr>
          ))}
        </Table>
      ) : (
        <p style={{ color: "var(--text-dim)" }}>{groups ? "No team groups yet." : "Loading…"}</p>
      )}
    </Page>
  );
}
