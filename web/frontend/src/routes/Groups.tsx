import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { Page } from "../components/Page";
import { Table, Td } from "../components/Table";
import { Empty, ErrorBlock, Loading } from "../components/State";

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
      .catch((e) => setError(errorText(e)));
  }, []);

  return (
    <Page title="Groups" eyebrow="Admin">
      <p style={{ color: "var(--text-dim)", marginTop: -8, marginBottom: 18 }}>
        All grants target groups — a "user only" grant uses their personal primary group.
      </p>
      {error && <ErrorBlock title="Couldn't load groups" error={error} />}
      {!error && groups === null && <Loading />}
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
        groups !== null && (
          <Empty
            glyph="◕"
            title="No team groups yet"
            body="Groups are UNIX groups on the main container. Create one there and it becomes grantable on every catalog — personal primary groups already exist for each user."
          />
        )
      )}
    </Page>
  );
}
