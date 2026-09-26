import { useEffect, useState } from "react";
import { api, errorText, type User } from "../api";
import { Page } from "../components/Page";
import { Table, Td } from "../components/Table";
import { Empty, ErrorBlock, Loading } from "../components/State";

interface UserRow {
  username: string;
  uid: number;
  gid: number;
  home: string;
}

export function Users({ user }: { user: User }) {
  // Non-admins get the page chrome and a plain notice — no fetch, so no 403
  // flashing up as an error.
  if (!user.admin) {
    return (
      <Page title="Users &amp; access" eyebrow="Admin">
      <Empty
        glyph="⊘"
        title="Admins only"
        body="This page is for members of the admins group. Ask an admin if you need an account or group changed."
      />
      </Page>
    );
  }
  return <UsersList />;
}

function UsersList() {
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
