import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { Page } from "../components/Page";
import { Table, Td } from "../components/Table";
import { Empty, ErrorBlock, Loading } from "../components/State";

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
      .catch((e) => setError(errorText(e)));
  }, []);

  return (
    <Page title="Users &amp; access" eyebrow="Admin">
      {error && <ErrorBlock title="Couldn't load users" error={error} />}
      {!error && users === null && <Loading />}
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
        users !== null && (
          <Empty
            glyph="◔"
            title="No Pebbles users yet"
            body="Every user is a real UNIX account in the reserved uid range. Accounts are provisioned by pebblesd on the main container — pebblesctl user add."
          />
        )
      )}
    </Page>
  );
}
