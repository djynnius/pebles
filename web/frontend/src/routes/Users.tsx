import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, errorText, type User } from "../api";
import { AccentButton, Card, GhostButton, Page } from "../components/Page";
import { Table, Td } from "../components/Table";
import { Empty, ErrorBlock, Loading } from "../components/State";
import {
  Badge,
  Field,
  FormMessage,
  InlineConfirm,
  InlinePanel,
  SmallButton,
  TextInput,
  USERNAME_RE,
  passwordProblem,
} from "../components/Form";

/*
 * /users — Users & access (admin only). Every Pebbles user is a real UNIX
 * account; admin rights are membership in the UNIX group `admins`. Nothing
 * here uses a browser dialog: resets and deletes expand inline under the row.
 */

interface UserRow {
  username: string;
  uid: number;
  gid: number;
  home: string;
  disabled?: boolean;
}

interface Group {
  name: string;
  gid: number;
  members: string[];
}

const ADMINS = "admins";
const enc = encodeURIComponent;

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
  return <UsersList me={user.username} />;
}

type Open = { username: string; mode: "reset" | "delete" } | null;

function UsersList({ me }: { me: string }) {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [admins, setAdmins] = useState<string[]>([]);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(""); // "<user>:<action>" while a row mutation is in flight
  const [open, setOpen] = useState<Open>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    return Promise.all([api.get<UserRow[]>("/users"), api.get<Group[]>("/groups")])
      .then(([u, g]) => {
        setUsers(u);
        setAdmins(g.find((x) => x.name === ADMINS)?.members ?? []);
        setLoadError("");
      })
      .catch((e) => setLoadError(errorText(e)));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /** Run a row mutation, surface the server's text on failure, refresh always. */
  const mutate = (key: string, label: string, call: () => Promise<unknown>) => {
    setBusy(key);
    setActionError("");
    call()
      .catch((e) => setActionError(`${label}: ${errorText(e)}`))
      .finally(() => {
        setBusy("");
        void load();
      });
  };

  const toggleDisabled = (u: UserRow) =>
    mutate(`${u.username}:disable`, `Couldn't ${u.disabled ? "enable" : "disable"} ${u.username}`, () =>
      api.post(`/users/${enc(u.username)}/disabled`, { disabled: !u.disabled }),
    );

  const toggleAdmin = (u: UserRow, isAdmin: boolean) =>
    mutate(
      `${u.username}:admin`,
      `Couldn't ${isAdmin ? "remove admin from" : "make admin"} ${u.username}`,
      () =>
        isAdmin
          ? api.del(`/groups/${ADMINS}/members/${enc(u.username)}`)
          : api.post(`/groups/${ADMINS}/members`, { username: u.username }),
    );

  const toggleOpen = (username: string, mode: "reset" | "delete") =>
    setOpen((o) => (o && o.username === username && o.mode === mode ? null : { username, mode }));

  return (
    <Page
      title="Users &amp; access"
      eyebrow="Admin"
      actions={
        !adding ? <AccentButton onClick={() => setAdding(true)}>Add user</AccentButton> : undefined
      }
    >
      <p style={{ color: "var(--text-dim)", fontSize: 12.5, marginTop: -8, marginBottom: 18 }}>
        Every user is a real UNIX account in the reserved uid range. Admins are members of the{" "}
        <code>admins</code> group.
      </p>

      {adding && (
        <AddUserForm
          onCancel={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void load();
          }}
        />
      )}

      {loadError && <ErrorBlock title="Couldn't load users" error={loadError} />}
      {actionError && <ErrorBlock error={actionError} />}
      {!loadError && users === null && <Loading />}

      {users && users.length > 0 ? (
        <Table head={["User", "uid", "Home", "Status", ""]}>
          {users.map((u) => {
            const self = u.username === me;
            const isAdmin = admins.includes(u.username);
            const lastAdmin = isAdmin && admins.length <= 1;
            const rowBusy = busy.startsWith(`${u.username}:`);
            const dim = u.disabled ? { opacity: 0.55 } : undefined;
            const expanded = open?.username === u.username ? open.mode : null;
            return (
              <UserRows
                key={u.username}
                u={u}
                self={self}
                isAdmin={isAdmin}
                lastAdmin={lastAdmin}
                rowBusy={rowBusy}
                busy={busy}
                dim={dim}
                expanded={expanded}
                onReset={() => toggleOpen(u.username, "reset")}
                onDelete={() => toggleOpen(u.username, "delete")}
                onToggleDisabled={() => toggleDisabled(u)}
                onToggleAdmin={() => toggleAdmin(u, isAdmin)}
                onClose={() => setOpen(null)}
                onDone={() => {
                  setOpen(null);
                  void load();
                }}
              />
            );
          })}
        </Table>
      ) : (
        users !== null && (
          <Empty
            glyph="◔"
            title="No Pebbles users yet"
            body="Every user is a real UNIX account in the reserved uid range. Add one here, or with pebblesctl user add on the main container."
            action={<AccentButton onClick={() => setAdding(true)}>Add user</AccentButton>}
          />
        )
      )}
    </Page>
  );
}

function UserRows({
  u,
  self,
  isAdmin,
  lastAdmin,
  rowBusy,
  busy,
  dim,
  expanded,
  onReset,
  onDelete,
  onToggleDisabled,
  onToggleAdmin,
  onClose,
  onDone,
}: {
  u: UserRow;
  self: boolean;
  isAdmin: boolean;
  lastAdmin: boolean;
  rowBusy: boolean;
  busy: string;
  dim: { opacity: number } | undefined;
  expanded: "reset" | "delete" | null;
  onReset: () => void;
  onDelete: () => void;
  onToggleDisabled: () => void;
  onToggleAdmin: () => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const selfTitle = "You can't change your own account here";
  return (
    <>
      <tr>
        <Td style={dim}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 12.5 }}>
              {u.username}
            </span>
            {self && <Badge tone="dim">you</Badge>}
            {isAdmin && <Badge tone="accent">Admin</Badge>}
          </span>
        </Td>
        <Td mono style={dim}>
          {u.uid}
        </Td>
        <Td mono style={dim}>
          {u.home}
        </Td>
        <Td style={dim}>
          {u.disabled ? <Badge tone="warn">Disabled</Badge> : <Badge tone="ok">Active</Badge>}
        </Td>
        <Td style={{ textAlign: "right" }}>
          <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <SmallButton
              onClick={onReset}
              disabled={self || rowBusy}
              title={self ? "Change your own password under Settings → Security & sessions" : undefined}
            >
              Reset password
            </SmallButton>
            <SmallButton
              onClick={onToggleDisabled}
              disabled={self || rowBusy}
              title={self ? selfTitle : undefined}
            >
              {busy === `${u.username}:disable`
                ? u.disabled
                  ? "Enabling…"
                  : "Disabling…"
                : u.disabled
                  ? "Enable"
                  : "Disable"}
            </SmallButton>
            <SmallButton
              onClick={onToggleAdmin}
              disabled={self || rowBusy || lastAdmin}
              title={self ? selfTitle : lastAdmin ? "The last admin can't be removed" : undefined}
            >
              {busy === `${u.username}:admin`
                ? "Saving…"
                : isAdmin
                  ? "Remove admin"
                  : "Make admin"}
            </SmallButton>
            <SmallButton
              danger
              onClick={onDelete}
              disabled={self || rowBusy}
              title={self ? selfTitle : undefined}
            >
              Delete
            </SmallButton>
          </span>
        </Td>
      </tr>
      {expanded && (
        <tr>
          <Td colSpan={5} style={{ background: "var(--surface-alt)" }}>
            {expanded === "reset" ? (
              <ResetPassword username={u.username} onCancel={onClose} onDone={onDone} />
            ) : (
              <DeleteUser username={u.username} home={u.home} onCancel={onClose} onDone={onDone} />
            )}
          </Td>
        </tr>
      )}
    </>
  );
}

function ResetPassword({
  username,
  onCancel,
  onDone,
}: {
  username: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(pw, confirm);
    if (problem) return setError(problem);
    setSaving(true);
    setError("");
    api
      .post(`/users/${enc(username)}/password`, { password: pw })
      .then(() => {
        setDone(true);
        setPw("");
        setConfirm("");
      })
      .catch((err) => setError(errorText(err)))
      .finally(() => setSaving(false));
  };

  if (done) {
    return (
      <InlinePanel>
        <div style={{ flex: 1 }}>
          <FormMessage tone="ok">Password for {username} was reset.</FormMessage>
        </div>
        <SmallButton onClick={onDone}>Close</SmallButton>
      </InlinePanel>
    );
  }

  return (
    <form onSubmit={submit}>
      <InlinePanel>
        <div style={{ fontWeight: 600, width: "100%" }}>Reset password for {username}</div>
        <TextInput
          type="password"
          value={pw}
          onChange={setPw}
          placeholder="New password (8+ characters)"
          ariaLabel="New password"
          autoComplete="new-password"
          autoFocus
          style={{ flex: 1, minWidth: 180, width: "auto" }}
        />
        <TextInput
          type="password"
          value={confirm}
          onChange={setConfirm}
          placeholder="Confirm new password"
          ariaLabel="Confirm new password"
          autoComplete="new-password"
          style={{ flex: 1, minWidth: 180, width: "auto" }}
        />
        <SmallButton type="submit" primary disabled={saving}>
          {saving ? "Resetting…" : "Reset password"}
        </SmallButton>
        <SmallButton onClick={onCancel} disabled={saving}>
          Cancel
        </SmallButton>
        {error && (
          <div style={{ width: "100%" }}>
            <FormMessage tone="err">{error}</FormMessage>
          </div>
        )}
      </InlinePanel>
    </form>
  );
}

function DeleteUser({
  username,
  home,
  onCancel,
  onDone,
}: {
  username: string;
  home: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [removeHome, setRemoveHome] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const confirmDelete = () => {
    setBusy(true);
    setError("");
    api
      .del(`/users/${enc(username)}?remove_home=${removeHome ? "true" : "false"}`)
      .then(onDone)
      .catch((e) => {
        setError(errorText(e));
        setBusy(false);
      });
  };

  return (
    <InlineConfirm
      message={`Delete ${username}?`}
      confirmLabel="Delete"
      busyLabel="Deleting…"
      busy={busy}
      onConfirm={confirmDelete}
      onCancel={onCancel}
      error={error}
    >
      <label
        style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontWeight: 400 }}
      >
        <input
          type="checkbox"
          checked={removeHome}
          disabled={busy}
          onChange={(e) => setRemoveHome(e.target.checked)}
        />
        <span>
          Also delete their home directory <code>{home}</code>
        </span>
      </label>
      {removeHome && (
        <div style={{ fontSize: 11.5, color: "var(--err)", marginTop: 4 }}>
          Files in {home} will be permanently removed and cannot be recovered.
        </div>
      )}
    </InlineConfirm>
  );
}

function AddUserForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!USERNAME_RE.test(username)) {
      return setError(
        "Username must start with a lowercase letter and use only a–z, 0–9, _ or - (max 32).",
      );
    }
    const problem = passwordProblem(pw, confirm);
    if (problem) return setError(problem);
    setSaving(true);
    setError("");
    api
      .post("/users", { username, password: pw })
      .then(onCreated)
      .catch((err) => {
        setError(errorText(err));
        setSaving(false);
      });
  };

  return (
    <Card style={{ padding: 18, marginBottom: 18 }}>
      <form onSubmit={submit}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Add user</div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            gap: 12,
            marginBottom: 14,
          }}
        >
          <Field label="Username" hint="Lowercase; becomes the UNIX account name">
            <TextInput
              value={username}
              onChange={(v) => setUsername(v.trim())}
              placeholder="maya"
              autoComplete="off"
              autoFocus
            />
          </Field>
          <Field label="Password" hint="At least 8 characters">
            <TextInput type="password" value={pw} onChange={setPw} autoComplete="new-password" />
          </Field>
          <Field label="Confirm password">
            <TextInput
              type="password"
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
            />
          </Field>
        </div>
        {error && (
          <div style={{ marginBottom: 12 }}>
            <FormMessage tone="err">{error}</FormMessage>
          </div>
        )}
        <div style={{ display: "flex", gap: 10 }}>
          <AccentButton type="submit" disabled={saving}>
            {saving ? "Creating…" : "Create user"}
          </AccentButton>
          <GhostButton onClick={onCancel} disabled={saving}>
            Cancel
          </GhostButton>
        </div>
      </form>
    </Card>
  );
}
