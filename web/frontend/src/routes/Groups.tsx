import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, errorText, type User } from "../api";
import { AccentButton, Card, Page } from "../components/Page";
import { Table, Td } from "../components/Table";
import { Empty, ErrorBlock, Loading } from "../components/State";
import {
  Badge,
  FormMessage,
  InlineConfirm,
  SmallButton,
  TextInput,
  USERNAME_RE,
  selectStyle,
} from "../components/Form";

/*
 * /groups — UNIX groups (admin only). Grants on catalogs and engines target
 * groups, so membership here *is* access control. `admins` is special: its
 * members are the Pebbles admins, it can't be deleted, and its last member
 * can't be removed.
 */

interface Group {
  name: string;
  gid: number;
  members: string[];
}

interface UserRow {
  username: string;
}

const ADMINS = "admins";
const enc = encodeURIComponent;

export function Groups({ user }: { user: User }) {
  // Non-admins get the page chrome and a plain notice — no fetch, so no 403
  // flashing up as an error.
  if (!user.admin) {
    return (
      <Page title="Groups" eyebrow="Admin">
        <Empty
          glyph="⊘"
          title="Admins only"
          body="This page is for members of the admins group. Ask an admin if you need an account or group changed."
        />
      </Page>
    );
  }
  return <GroupsList />;
}

function GroupsList() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [users, setUsers] = useState<string[]>([]);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(""); // "<group>:<action>"
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");

  const load = useCallback(() => {
    return Promise.all([api.get<Group[]>("/groups"), api.get<UserRow[]>("/users")])
      .then(([g, u]) => {
        setGroups(g);
        setUsers(u.map((x) => x.username));
        setLoadError("");
      })
      .catch((e) => setLoadError(errorText(e)));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

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

  const addMember = (g: string, u: string) =>
    mutate(`${g}:add`, `Couldn't add ${u} to ${g}`, () =>
      api.post(`/groups/${enc(g)}/members`, { username: u }),
    );

  const removeMember = (g: string, u: string) =>
    mutate(`${g}:rm:${u}`, `Couldn't remove ${u} from ${g}`, () =>
      api.del(`/groups/${enc(g)}/members/${enc(u)}`),
    );

  const deleteGroup = (g: string) => {
    setBusy(`${g}:delete`);
    setDeleteError("");
    api
      .del(`/groups/${enc(g)}`)
      .then(() => setConfirming(null))
      .catch((e) => setDeleteError(errorText(e)))
      .finally(() => {
        setBusy("");
        void load();
      });
  };

  return (
    <Page title="Groups" eyebrow="Admin">
      <p style={{ color: "var(--text-dim)", fontSize: "var(--fs-body)", marginTop: -8, marginBottom: 18 }}>
        Groups are UNIX groups on the main container; every grant (catalogs, engines) targets a
        group — a "user only" grant uses that user's personal primary group.
      </p>

      <CreateGroup onCreated={() => void load()} />

      {loadError && <ErrorBlock title="Couldn't load groups" error={loadError} />}
      {actionError && <ErrorBlock error={actionError} />}
      {!loadError && groups === null && <Loading />}

      {groups && groups.length > 0 ? (
        <Table head={["Group", "gid", "Members", ""]}>
          {groups.map((g) => {
            const special = g.name === ADMINS;
            const candidates = users.filter((u) => !g.members.includes(u));
            const groupBusy = busy.startsWith(`${g.name}:`);
            return (
              <GroupRows
                key={g.name}
                g={g}
                special={special}
                candidates={candidates}
                groupBusy={groupBusy}
                busy={busy}
                confirming={confirming === g.name}
                deleteError={confirming === g.name ? deleteError : ""}
                onAdd={(u) => addMember(g.name, u)}
                onRemove={(u) => removeMember(g.name, u)}
                onAskDelete={() => {
                  setDeleteError("");
                  setConfirming(confirming === g.name ? null : g.name);
                }}
                onCancelDelete={() => setConfirming(null)}
                onDelete={() => deleteGroup(g.name)}
              />
            );
          })}
        </Table>
      ) : (
        groups !== null && (
          <Empty
            glyph="◕"
            title="No team groups yet"
            body="Create one above and it becomes grantable on every catalog and engine — personal primary groups already exist for each user."
          />
        )
      )}
    </Page>
  );
}

function GroupRows({
  g,
  special,
  candidates,
  groupBusy,
  busy,
  confirming,
  deleteError,
  onAdd,
  onRemove,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  g: Group;
  special: boolean;
  candidates: string[];
  groupBusy: boolean;
  busy: string;
  confirming: boolean;
  deleteError: string;
  onAdd: (u: string) => void;
  onRemove: (u: string) => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const lastAdmin = special && g.members.length <= 1;
  return (
    <>
      <tr>
        <Td>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ fontSize: "var(--fs-body)" }}>
              {g.name}
            </span>
            {special && <Badge tone="accent">Admins</Badge>}
          </span>
        </Td>
        <Td mono>{g.gid}</Td>
        <Td>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            {g.members.length === 0 && (
              <span style={{ color: "var(--text-dim)", fontSize: "var(--fs-meta)" }}>No members</span>
            )}
            {g.members.map((m) => (
              <Chip
                key={m}
                label={m}
                removing={busy === `${g.name}:rm:${m}`}
                disabled={groupBusy}
                onRemove={lastAdmin ? undefined : () => onRemove(m)}
              />
            ))}
            {candidates.length > 0 && (
              <select
                aria-label={`Add member to ${g.name}`}
                value=""
                disabled={groupBusy}
                onChange={(e) => e.target.value && onAdd(e.target.value)}
                style={{ ...selectStyle, padding: "4px 8px", fontSize: "var(--fs-meta)" }}
              >
                <option value="">
                  {busy === `${g.name}:add` ? "Adding…" : "+ Add member"}
                </option>
                {candidates.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            )}
          </div>
        </Td>
        <Td style={{ textAlign: "right" }}>
          {!special && (
            <SmallButton danger onClick={onAskDelete} disabled={groupBusy}>
              Delete
            </SmallButton>
          )}
        </Td>
      </tr>
      {confirming && (
        <tr>
          <Td colSpan={4} style={{ background: "var(--surface-alt)" }}>
            <InlineConfirm
              message={`Delete group ${g.name}?`}
              confirmLabel="Delete group"
              busyLabel="Deleting…"
              busy={busy === `${g.name}:delete`}
              onConfirm={onDelete}
              onCancel={onCancelDelete}
              error={deleteError}
            >
              <div style={{ fontSize: "var(--fs-small)", color: "var(--text-mid)", marginTop: 4, fontWeight: 400 }}>
                Members lose any access granted through this group. Their accounts and files are
                untouched.
              </div>
            </InlineConfirm>
          </Td>
        </tr>
      )}
    </>
  );
}

function Chip({
  label,
  onRemove,
  removing,
  disabled,
}: {
  label: string;
  onRemove?: () => void;
  removing: boolean;
  disabled: boolean;
}) {
  return (
    <span
      className="mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: onRemove ? "3px 4px 3px 10px" : "3px 10px",
        borderRadius: 20,
        border: "1px solid var(--border)",
        background: "var(--surface-alt)",
        color: "var(--text-mid)",
        fontSize: "var(--fs-small)",
        opacity: removing ? 0.5 : 1,
      }}
    >
      {removing ? `${label} …` : label}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          title={`Remove ${label}`}
          onClick={onRemove}
          disabled={disabled}
          style={{
            border: "none",
            background: "transparent",
            color: "var(--text-dim)",
            fontSize: "var(--fs-base)",
            lineHeight: 1,
            padding: "0 5px",
            borderRadius: 10,
            cursor: disabled ? "default" : "pointer",
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

function CreateGroup({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!USERNAME_RE.test(name)) {
      return setError(
        "Group name must start with a lowercase letter and use only a–z, 0–9, _ or - (max 32).",
      );
    }
    setSaving(true);
    setError("");
    api
      .post("/groups", { name })
      .then(() => {
        setName("");
        onCreated();
      })
      .catch((err) => setError(errorText(err)))
      .finally(() => setSaving(false));
  };

  return (
    <Card style={{ padding: 14, marginBottom: 18 }}>
      <form onSubmit={submit} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <TextInput
          value={name}
          onChange={(v) => setName(v.trim())}
          placeholder="new-group-name"
          ariaLabel="New group name"
          autoComplete="off"
          style={{ flex: 1, minWidth: 200, width: "auto" }}
        />
        <AccentButton type="submit" disabled={saving}>
          {saving ? "Creating…" : "Create group"}
        </AccentButton>
        {error && (
          <div style={{ width: "100%" }}>
            <FormMessage tone="err">{error}</FormMessage>
          </div>
        )}
      </form>
    </Card>
  );
}
