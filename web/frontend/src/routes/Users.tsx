import { useEffect, useState } from "react";
import { api } from "../api";
import { Page } from "../components/Page";
import { Table, Td } from "../components/Table";

interface UserRow {
  username: string;
  uid: number;
  gid: number;
  home: string;
}

export function Users() {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .get<UserRow[]>("/users")
      .then(setUsers)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  return (
    <Page title="Users &amp; access" eyebrow="Admin">
      {error && <p style={{ color: "var(--err)" }}>{error}</p>}
      {users && users.length > 0 ? (
        <Table head={["User", "uid", "gid", "Home"]}>
          {users.map((u) => (
            <tr key={u.username}>
              <Td>{u.username}</Td>
              <Td mono>{u.uid}</Td>
              <Td mono>{u.gid}</Td>
              <Td mono>{u.home}</Td>
            </tr>
          ))}
        </Table>
      ) : (
        <p style={{ color: "var(--text-dim)" }}>{users ? "No users yet." : "Loading…"}</p>
      )}
    </Page>
  );
}
