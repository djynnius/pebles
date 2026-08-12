import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, type User } from "../api";

/*
 * /settings — account & settings (spec §5 "settings"). Left rail of tabs, right
 * pane per tab, with the workspace-admin tabs below a divider. Everything here
 * lands in the signed-in user's own home or in pebblesd's config — Flask holds
 * no credential of its own (NFR-01, REQ-34).
 */

type TabId =
  | "profile"
  | "security"
  | "home"
  | "git"
  | "nkoyo"
  | "skills"
  | "tokens"
  | "runtime"
  | "approvals";

const USER_TABS: { id: TabId; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "security", label: "Security & sessions" },
  { id: "home", label: "Home directory" },
  { id: "git", label: "Git & repos" },
  { id: "nkoyo", label: "Nkoyo model" },
  { id: "skills", label: "Agent skills" },
  { id: "tokens", label: "API tokens" },
];

const ADMIN_TABS: { id: TabId; label: string }[] = [
  { id: "runtime", label: "Compute runtime" },
  { id: "approvals", label: "Engine approvals" },
];

export function Settings({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [tab, setTab] = useState<TabId>("profile");
  const initials = user.username.slice(0, 2).toUpperCase();

  return (
    <div style={{ display: "flex", minHeight: "calc(100vh - 52px)" }}>
      {/* ---- tab rail ------------------------------------------------------ */}
      <aside
        style={{
          width: 236,
          flex: "0 0 236px",
          borderRight: "1px solid var(--border)",
          background: "var(--surface-alt)",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 6px 14px" }}>
          <span
            style={{
              width: 32,
              height: 32,
              borderRadius: "50%",
              background: "var(--accent-deep)",
              color: "var(--deep-text)",
              display: "grid",
              placeItems: "center",
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            {initials}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>{user.username}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--text-dim)" }}>
              uid {user.uid}
            </div>
          </div>
        </div>

        {USER_TABS.map((t) => (
          <TabButton key={t.id} label={t.label} on={tab === t.id} onClick={() => setTab(t.id)} />
        ))}

        <div
          style={{
            fontSize: 10.5,
            letterSpacing: "0.8px",
            textTransform: "uppercase",
            color: "var(--text-faint)",
            padding: "14px 6px 6px",
          }}
        >
          — Workspace · admin —
        </div>
        {ADMIN_TABS.map((t) => (
          <TabButton key={t.id} label={t.label} on={tab === t.id} onClick={() => setTab(t.id)} />
        ))}

        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onSignOut}
          style={{
            textAlign: "left",
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--text-mid)",
            borderRadius: 11,
            fontSize: 13,
            padding: "8px 12px",
          }}
        >
          ⏻ Sign out
        </button>
      </aside>

      {/* ---- pane ---------------------------------------------------------- */}
      <div style={{ flex: 1, minWidth: 0, padding: "34px 40px 60px", maxWidth: 900 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.4px", marginBottom: 20 }}>
          {[...USER_TABS, ...ADMIN_TABS].find((t) => t.id === tab)?.label}
        </h1>
        {tab === "profile" && <ProfilePane user={user} />}
        {tab === "security" && <SecurityPane user={user} />}
        {tab === "home" && <HomePane />}
        {tab === "git" && <GitPane />}
        {tab === "nkoyo" && <NkoyoPane />}
        {tab === "skills" && <SkillsPane />}
        {tab === "tokens" && <TokensPane />}
        {tab === "runtime" && <RuntimePane />}
        {tab === "approvals" && <ApprovalsPane />}
      </div>
    </div>
  );
}

function TabButton({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: "left",
        border: "none",
        borderRadius: 10,
        padding: "8px 10px",
        fontSize: 13.5,
        background: on ? "var(--surface)" : "transparent",
        color: on ? "var(--text)" : "var(--text-muted)",
        fontWeight: on ? 600 : 400,
        boxShadow: on ? "inset 2px 0 0 var(--accent)" : "none",
      }}
    >
      {label}
    </button>
  );
}

/* ---- profile / security / home ------------------------------------------ */

interface UserRow {
  username: string;
  uid: number;
  gid: number;
  home: string;
}

function ProfilePane({ user }: { user: User }) {
  const [row, setRow] = useState<UserRow | null>(null);
  useEffect(() => {
    api
      .get<UserRow[]>("/users")
      .then((all) => setRow(all.find((u) => u.username === user.username) ?? null))
      .catch(() => {});
  }, [user.username]);

  return (
    <Card>
      <FieldRow label="Username" value={user.username} mono />
      <FieldRow label="uid" value={String(user.uid)} mono />
      <FieldRow label="gid" value={row ? String(row.gid) : "—"} mono />
      <FieldRow label="Home" value={row?.home ?? "—"} mono />
      <div style={{ padding: "0 18px 14px" }}>
        <Note>
          Your Pebbles identity is a real UNIX account in the reserved range — sessions run as this
          uid, and every grant targets a UNIX group. There is no second account system.
        </Note>
      </div>
    </Card>
  );
}

function SecurityPane({ user }: { user: User }) {
  return (
    <>
      <Card>
        <FieldRow label="Signed in as" value={user.username} mono />
        <FieldRow label="Session" value="Browser cookie, this device only" last />
      </Card>
      <Note>
        Passwords are verified against the host shadow database by pebblesd — changing yours from
        the web tier arrives in a later phase. Signing out clears this cookie; other devices keep
        their own sessions until they sign out.
      </Note>
    </>
  );
}

interface Disk {
  mount: string;
  total_bytes: number;
  free_bytes: number;
}
interface Usage {
  hostname: string;
  disks: Disk[];
}

const gb = (b: number) => (b / 1024 ** 3).toFixed(1);

function HomePane() {
  const nav = useNavigate();
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    api.get<Usage>("/usage").then(setUsage).catch(() => {});
  }, []);

  return (
    <>
      <Card>
        <FieldRow label="Host" value={usage?.hostname ?? "—"} mono />
        {(usage?.disks ?? []).map((d, i, all) => (
          <FieldRow
            key={d.mount}
            label={`Disk ${d.mount}`}
            value={`${gb(d.total_bytes - d.free_bytes)} GB used of ${gb(d.total_bytes)} GB`}
            last={i === all.length - 1}
          />
        ))}
      </Card>
      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <button type="button" onClick={() => nav("/files")} style={ghost}>
          Open Files
        </button>
      </div>
      <Note>
        Your home is bind-mounted into every session at <code>/workspace</code>. There is no quota
        system in v1 — the disk numbers above are the whole story.
      </Note>
    </>
  );
}

/* ---- git & repos --------------------------------------------------------- */

interface RepoStatus {
  branch: string;
  ahead: number;
  behind: number;
  files: { path: string; staged: boolean; unstaged: boolean; untracked?: boolean }[];
}

interface GitResult {
  ok?: boolean;
  stdout?: string;
  stderr?: string;
}

function GitPane() {
  const [pubkey, setPubkey] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [host, setHost] = useState("github.com");
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  const [repos, setRepos] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const loadKey = useCallback(() => {
    api
      .get<{ pubkey: string }>("/settings/git")
      .then((g) => setPubkey(g.pubkey))
      .catch((e) => setError(String(e.message ?? e)));
  }, []);
  const loadRepos = useCallback(() => {
    api
      .get<string[]>("/repos")
      .then(setRepos)
      .catch(() => setRepos([]));
  }, []);

  useEffect(() => {
    loadKey();
    loadRepos();
  }, [loadKey, loadRepos]);

  const post = (body: Record<string, unknown>, done: string) => {
    setError("");
    api
      .post("/settings/git", body)
      .then(() => {
        setStatus(done);
        loadKey();
      })
      .catch((e) => setError(String(e.message ?? e)));
  };

  const clone = () => {
    setError("");
    setStatus("");
    api
      .post<{ name: string }>("/repos/clone", { url: url.trim(), name: cloneName.trim() || undefined })
      .then((r) => {
        setStatus(`Cloned ${r.name}.`);
        setUrl("");
        setCloneName("");
        loadRepos();
      })
      .catch((e) => setError(String(e.message ?? e)));
  };

  return (
    <>
      {status && <p style={{ color: "var(--ok-ink)", fontSize: 12.5, marginBottom: 12 }}>{status}</p>}
      {error && <p style={{ color: "var(--err)", fontSize: 12.5, marginBottom: 12 }}>{error}</p>}

      <SectionTitle>Commit identity</SectionTitle>
      <Card style={{ padding: 18, display: "grid", gap: 12 }}>
        <Labelled label="Commit name">
          <input value={name} onChange={(e) => setName(e.target.value)} style={input} />
        </Labelled>
        <Labelled label="Commit email">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            className="mono"
            style={input}
          />
        </Labelled>
        <div>
          <button
            type="button"
            onClick={() => post({ action: "identity", name, email }, "Identity saved to ~/.gitconfig.")}
            style={accent}
          >
            Save identity
          </button>
        </div>
      </Card>

      <SectionTitle>SSH key</SectionTitle>
      <Card style={{ padding: 18 }}>
        {pubkey ? (
          <>
            <div style={{ fontSize: 12.5, color: "var(--text-mid)", marginBottom: 8 }}>
              Add this public key to your git host:
            </div>
            <pre
              className="mono"
              style={{
                fontSize: 11.5,
                background: "var(--surface-alt)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: 12,
                whiteSpace: "pre-wrap",
                overflowWrap: "break-word",
              }}
            >
              {pubkey.trim()}
            </pre>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginBottom: 10 }}>
            No key yet — generate an ed25519 pair in your <code>~/.ssh</code>.
          </div>
        )}
        <button
          type="button"
          onClick={() => post({ action: "keygen" }, "Key checked — generated if it was missing.")}
          style={{ ...ghost, marginTop: 10 }}
        >
          {pubkey ? "Check / regenerate" : "Generate key"}
        </button>
      </Card>

      <SectionTitle>HTTPS token</SectionTitle>
      <Card style={{ padding: 18, display: "grid", gap: 12 }}>
        <Labelled label="Host">
          <input value={host} onChange={(e) => setHost(e.target.value)} className="mono" style={input} />
        </Labelled>
        <Labelled label="Personal access token">
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            className="mono"
            style={input}
          />
        </Labelled>
        <div>
          <button
            type="button"
            onClick={() => {
              post({ action: "pat", host, token }, "Token stored at ~/.git-credentials (0600).");
              setToken("");
            }}
            style={accent}
          >
            Store token
          </button>
        </div>
        <Note>
          Identity, key, and token all live in <em>your</em> home. Pebbles never holds a shared
          credential.
        </Note>
      </Card>

      <SectionTitle>Repositories</SectionTitle>
      <Card style={{ padding: 18, display: "grid", gap: 12, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="git@github.com:team/analytics.git"
            className="mono"
            style={{ ...input, flex: 2, minWidth: 240 }}
          />
          <input
            value={cloneName}
            onChange={(e) => setCloneName(e.target.value)}
            placeholder="local name (optional)"
            className="mono"
            style={{ ...input, flex: 1, minWidth: 160 }}
          />
          <button type="button" onClick={clone} disabled={!url.trim()} style={accent}>
            Clone
          </button>
        </div>
      </Card>

      {repos.length === 0 ? (
        <p style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
          No repositories yet — clone one into <code>~/repos</code>.
        </p>
      ) : (
        <Card style={{ overflow: "hidden" }}>
          {repos.map((r) => (
            <Repo key={r} name={r} open={open === r} onToggle={() => setOpen(open === r ? null : r)} />
          ))}
        </Card>
      )}
    </>
  );
}

function Repo({ name, open, onToggle }: { name: string; open: boolean; onToggle: () => void }) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [message, setMessage] = useState("");
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    api
      .get<RepoStatus>(`/repos/${encodeURIComponent(name)}/status`)
      .then(setStatus)
      .catch((e) => setOut(String(e.message ?? e)));
  }, [name]);

  useEffect(() => {
    if (open && status === null) refresh();
  }, [open, status, refresh]);

  const run = (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setOut("");
    api
      .post<GitResult>(`/repos/${encodeURIComponent(name)}/git`, { action, ...extra })
      .then((r) => setOut((r.stdout || "") + (r.stderr ? `\n${r.stderr}` : "") || "done"))
      .catch((e) => setOut(String(e.message ?? e)))
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };

  return (
    <div style={{ borderBottom: "1px solid var(--border-soft)" }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          width: "100%",
          textAlign: "left",
          border: "none",
          background: "transparent",
          padding: "12px 18px",
          fontSize: 13,
          color: "var(--text)",
        }}
      >
        <span style={{ color: "var(--text-faint)", width: 10 }}>{open ? "▾" : "▸"}</span>
        <span className="mono">{name}</span>
        {status && (
          <span className="mono" style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
            {status.branch || "detached"} · ↑{status.ahead} ↓{status.behind} ·{" "}
            {status.files.length} changed
          </span>
        )}
      </button>

      {open && (
        <div style={{ padding: "0 18px 16px", display: "grid", gap: 10 }}>
          {status && status.files.length > 0 && (
            <div
              className="mono"
              style={{
                fontSize: 11.5,
                color: "var(--text-mid)",
                background: "var(--surface-alt)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: 10,
                maxHeight: 160,
                overflow: "auto",
              }}
            >
              {status.files.map((f) => (
                <div key={f.path}>
                  <span style={{ color: f.staged ? "var(--ok-ink)" : "var(--text-faint)" }}>
                    {f.untracked ? "?" : f.staged ? "S" : " "}
                  </span>
                  {f.unstaged ? "M" : " "} {f.path}
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message"
              style={{ ...input, flex: 1, minWidth: 200 }}
            />
            <button
              type="button"
              disabled={busy || !message.trim()}
              onClick={() => run("commit", { message })}
              style={ghost}
            >
              Commit
            </button>
            <button type="button" disabled={busy} onClick={() => run("push")} style={ghost}>
              Push
            </button>
            <button type="button" disabled={busy} onClick={() => run("pull")} style={ghost}>
              Pull
            </button>
            <button type="button" disabled={busy} onClick={() => run("log")} style={ghost}>
              Log
            </button>
          </div>
          {out && (
            <pre
              className="mono"
              style={{
                fontSize: 11.5,
                background: "var(--deep-soft)",
                color: "var(--deep-text-2)",
                borderRadius: 12,
                padding: 12,
                maxHeight: 240,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                overflowWrap: "break-word",
              }}
            >
              {out}
            </pre>
          )}
          <Note>
            Every git command runs as you, inside your home — commits carry your identity, not the
            platform's.
          </Note>
        </div>
      )}
    </div>
  );
}

/* ---- nkoyo model --------------------------------------------------------- */

interface NkoyoConfig {
  endpoints: string[];
  planner_model: string;
  coder_model: string;
  embed_model: string;
  max_steps: number;
}

interface Detected {
  endpoint: string;
  models: string[];
}

function NkoyoPane() {
  const [cfg, setCfg] = useState<NkoyoConfig | null>(null);
  const [endpoints, setEndpoints] = useState("");
  const [detected, setDetected] = useState<Detected[] | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<NkoyoConfig>("/nkoyo/config")
      .then((c) => {
        setCfg(c);
        setEndpoints((c.endpoints ?? []).join("\n"));
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  if (!cfg) {
    return <p style={{ color: "var(--text-dim)", fontSize: 13 }}>{error || "Loading…"}</p>;
  }

  const patch = (changes: Partial<NkoyoConfig>) => setCfg({ ...cfg, ...changes });

  const save = () => {
    setBusy(true);
    setStatus("");
    setError("");
    api
      .post<NkoyoConfig>("/nkoyo/config", {
        ...cfg,
        endpoints: endpoints.split("\n").map((e) => e.trim()).filter(Boolean),
      })
      .then((c) => {
        setCfg(c);
        setEndpoints((c.endpoints ?? []).join("\n"));
        setStatus("Saved.");
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };

  const rescan = () => {
    setBusy(true);
    setStatus("");
    setError("");
    api
      .post<Detected[]>("/nkoyo/rescan")
      .then(setDetected)
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      {status && <p style={{ color: "var(--ok-ink)", fontSize: 12.5, marginBottom: 12 }}>{status}</p>}
      {error && <p style={{ color: "var(--err)", fontSize: 12.5, marginBottom: 12 }}>{error}</p>}

      <Card style={{ padding: 18, display: "grid", gap: 14 }}>
        <Labelled label="Endpoints (one per line)">
          <textarea
            value={endpoints}
            onChange={(e) => setEndpoints(e.target.value)}
            rows={3}
            placeholder="http://10.0.0.7:11434"
            className="mono"
            style={{ ...input, resize: "vertical", fontSize: 12.5 }}
          />
        </Labelled>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14 }}>
          <Labelled label="Planning model">
            <input
              value={cfg.planner_model}
              onChange={(e) => patch({ planner_model: e.target.value })}
              className="mono"
              style={input}
            />
          </Labelled>
          <Labelled label="Code / SQL model">
            <input
              value={cfg.coder_model}
              onChange={(e) => patch({ coder_model: e.target.value })}
              className="mono"
              style={input}
            />
          </Labelled>
          <Labelled label="Embedding model">
            <input
              value={cfg.embed_model}
              onChange={(e) => patch({ embed_model: e.target.value })}
              className="mono"
              style={input}
            />
          </Labelled>
          <Labelled label="Max agent steps">
            <input
              type="number"
              min={1}
              max={64}
              value={cfg.max_steps}
              onChange={(e) => patch({ max_steps: Number(e.target.value) })}
              className="mono"
              style={input}
            />
          </Labelled>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" onClick={busy ? undefined : save} style={accent}>
            {busy ? "Working…" : "Save"}
          </button>
          <button type="button" onClick={busy ? undefined : rescan} style={ghost}>
            Rescan hosts
          </button>
        </div>
        <Note>
          Local Ollama only — endpoints are probed across the fleet and nothing leaves your hosts.
        </Note>
      </Card>

      {detected && (
        <>
          <SectionTitle>Detected</SectionTitle>
          <Card style={{ overflow: "hidden" }}>
            {detected.length === 0 ? (
              <div style={{ padding: 18, fontSize: 12.5, color: "var(--text-dim)" }}>
                No Ollama endpoint answered on the fleet.
              </div>
            ) : (
              detected.map((d) => (
                <div
                  key={d.endpoint}
                  style={{ padding: "12px 18px", borderBottom: "1px solid var(--border-soft)" }}
                >
                  <div className="mono" style={{ fontSize: 12.5 }}>
                    {d.endpoint}
                  </div>
                  <div className="mono" style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                    {d.models.join(", ") || "no models"}
                  </div>
                </div>
              ))
            )}
          </Card>
        </>
      )}
    </>
  );
}

/* ---- skills -------------------------------------------------------------- */

function SkillsPane() {
  return (
    <>
      <Card style={{ padding: 18 }}>
        <div style={{ fontSize: 13, color: "var(--text-mid)", marginBottom: 10 }}>
          Skills are folders of instructions Nkoyo reads before it plans. Drop a{" "}
          <code>SKILL.md</code> into either directory and it loads on the next turn:
        </div>
        <div className="mono" style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.9 }}>
          ~/.pebbles/skills/&lt;name&gt;/SKILL.md
          <br />
          /opt/pebbles/skills/&lt;name&gt;/SKILL.md
        </div>
      </Card>
      <SectionTitle>Tool grades</SectionTitle>
      <Card style={{ padding: 18, display: "grid", gap: 8 }}>
        <Legend tone="var(--ok)" label="Enabled" text="read-only tools run without asking" />
        <Legend tone="var(--warn)" label="Enforced" text="mutating tools ask for approval first" />
        <Legend tone="var(--text-dim)" label="Disabled" text="blocked by policy — never runs" />
        <Note>
          Grades are enforced by pebblesd, not the browser, and every tool executes inside your own
          session — Nkoyo can never exceed your grants.
        </Note>
      </Card>
    </>
  );
}

function Legend({ tone, label, text }: { tone: string; label: string; text: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: tone }} />
      <span style={{ fontWeight: 600, width: 80 }}>{label}</span>
      <span style={{ color: "var(--text-dim)" }}>{text}</span>
    </div>
  );
}

/* ---- tokens -------------------------------------------------------------- */

interface TokenInfo {
  id: string;
  expires_at: number;
  used: boolean;
}

const when = (secs: number) => new Date(secs * 1000).toLocaleString();

function TokensPane() {
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [minted, setMinted] = useState<{ id: string; token: string; expires_at: number } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .get<TokenInfo[]>("/tokens")
      .then(setTokens)
      .catch((e) => {
        setError(String(e.message ?? e));
        setTokens([]);
      });
  }, []);
  useEffect(load, [load]);

  const mint = () => {
    setError("");
    api
      .post<{ id: string; token: string; expires_at: number }>("/tokens")
      .then((t) => {
        setMinted(t);
        setCopied(false);
        load();
      })
      .catch((e) => setError(String(e.message ?? e)));
  };

  const revoke = (id: string) => {
    if (!confirm(`Revoke join token ${id}?`)) return;
    api
      .del(`/tokens/${encodeURIComponent(id)}`)
      .then(load)
      .catch((e) => setError(String(e.message ?? e)));
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <button type="button" onClick={mint} style={accent}>
          Mint join token
        </button>
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          Single-use, 24 h expiry — an engine trades it for cluster membership.
        </span>
      </div>

      {error && <p style={{ color: "var(--err)", fontSize: 12.5, marginBottom: 12 }}>{error}</p>}

      {minted && (
        <div
          style={{
            background: "var(--accent-tint)",
            border: "1px solid var(--accent)",
            borderRadius: 14,
            padding: 16,
            marginBottom: 16,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--accent-tint-ink)" }}>
            Copy this now — it is shown once and never stored in plaintext.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
            <code style={{ fontSize: 12.5, wordBreak: "break-all", flex: 1 }}>{minted.token}</code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(minted.token).then(
                  () => setCopied(true),
                  () => setCopied(false),
                );
              }}
              style={ghost}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--accent-tint-ink)", marginTop: 6 }}>
            id {minted.id} · expires {when(minted.expires_at)}
          </div>
        </div>
      )}

      {tokens && tokens.length > 0 ? (
        <Card style={{ overflow: "hidden" }}>
          {tokens.map((t) => (
            <div
              key={t.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 18px",
                borderBottom: "1px solid var(--border-soft)",
                fontSize: 12.5,
              }}
            >
              <span className="mono" style={{ minWidth: 90 }}>
                {t.id}
              </span>
              <span style={{ color: "var(--text-dim)" }}>expires {when(t.expires_at)}</span>
              <span
                style={{
                  padding: "3px 9px",
                  borderRadius: 20,
                  fontSize: 10.5,
                  fontWeight: 600,
                  background: t.used ? "var(--track)" : "var(--ok-tint)",
                  color: t.used ? "var(--text-dim)" : "var(--ok-ink)",
                }}
              >
                {t.used ? "USED" : "UNUSED"}
              </span>
              <div style={{ flex: 1 }} />
              <button type="button" onClick={() => revoke(t.id)} style={ghost}>
                Revoke
              </button>
            </div>
          ))}
        </Card>
      ) : (
        <p style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
          {tokens ? "No join tokens outstanding." : "Loading…"}
        </p>
      )}
    </>
  );
}

/* ---- compute runtime & approvals ----------------------------------------- */

interface EngineRow {
  name: string;
  address: string;
  state: string;
  sessions: number;
  resources: { cpus: number; memory_bytes: number };
}

function RuntimePane() {
  const nav = useNavigate();
  const [engines, setEngines] = useState<EngineRow[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .get<EngineRow[]>("/engines")
      .then(setEngines)
      .catch((e) => {
        setError(String(e.message ?? e));
        setEngines([]);
      });
  }, []);
  useEffect(load, [load]);

  const deregister = (name: string) => {
    if (!confirm(`Deregister ${name}? Its credentials stop working immediately.`)) return;
    api
      .del(`/engines/${encodeURIComponent(name)}`)
      .then(load)
      .catch((e) => setError(String(e.message ?? e)));
  };

  return (
    <>
      {error && <p style={{ color: "var(--err)", fontSize: 12.5, marginBottom: 12 }}>{error}</p>}
      {engines && engines.length > 0 ? (
        <Card style={{ overflow: "hidden" }}>
          {engines.map((e) => (
            <div
              key={e.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 18px",
                borderBottom: "1px solid var(--border-soft)",
                fontSize: 12.5,
              }}
            >
              <span className="mono" style={{ minWidth: 140 }}>
                {e.name}
              </span>
              <span style={{ color: "var(--text-dim)" }}>{e.state}</span>
              <span style={{ color: "var(--text-dim)" }}>
                {e.sessions} session{e.sessions === 1 ? "" : "s"} · {e.resources.cpus} cpu
              </span>
              <div style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => nav(`/engineconfig?engine=${encodeURIComponent(e.name)}`)}
                style={ghost}
              >
                Configure
              </button>
              <button type="button" onClick={() => deregister(e.name)} style={ghost}>
                Deregister
              </button>
            </div>
          ))}
        </Card>
      ) : (
        <p style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
          {engines ? "No engines registered." : "Loading…"}
        </p>
      )}
      <div style={{ marginTop: 14 }}>
        <button type="button" onClick={() => nav("/engines")} style={ghost}>
          Open Engines
        </button>
      </div>
      <Note>
        Engines are containers on your own hardware — Docker, rootful Podman, or Incus. Removing one
        invalidates its credentials; it can rejoin with a fresh join token.
      </Note>
    </>
  );
}

interface PendingEngine {
  name: string;
  address: string;
  cpus: number;
  first_seen: number;
  approved: boolean;
}

function ApprovalsPane() {
  const [pending, setPending] = useState<PendingEngine[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .get<PendingEngine[]>("/engines/pending")
      .then(setPending)
      .catch((e) => {
        setError(String(e.message ?? e));
        setPending([]);
      });
  }, []);
  useEffect(load, [load]);

  const act = (name: string, approve: boolean) => {
    setError("");
    const call = approve
      ? api.post(`/engines/pending/${encodeURIComponent(name)}/approve`)
      : api.del(`/engines/pending/${encodeURIComponent(name)}`);
    call.then(load).catch((e) => setError(String(e.message ?? e)));
  };

  return (
    <>
      {error && <p style={{ color: "var(--err)", fontSize: 12.5, marginBottom: 12 }}>{error}</p>}
      {pending && pending.length > 0 ? (
        <Card style={{ overflow: "hidden" }}>
          {pending.map((p) => (
            <div
              key={p.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 18px",
                borderBottom: "1px solid var(--border-soft)",
                fontSize: 12.5,
              }}
            >
              <span className="mono" style={{ minWidth: 140 }}>
                {p.name}
              </span>
              <span className="mono" style={{ color: "var(--text-dim)" }}>
                {p.address}
              </span>
              <span style={{ color: "var(--text-dim)" }}>{p.cpus} cpu</span>
              <span style={{ color: "var(--text-dim)" }}>seen {when(p.first_seen)}</span>
              <div style={{ flex: 1 }} />
              <button type="button" onClick={() => act(p.name, true)} style={accent}>
                Approve
              </button>
              <button type="button" onClick={() => act(p.name, false)} style={ghost}>
                Reject
              </button>
            </div>
          ))}
        </Card>
      ) : (
        <p style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
          {pending ? "Nothing waiting for approval." : "Loading…"}
        </p>
      )}
      <Note>
        An engine that arrives without a valid join token waits here — it keeps retrying until you
        approve or reject it (REQ-06).
      </Note>
    </>
  );
}

/* ---- shared bits --------------------------------------------------------- */

function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 style={{ fontSize: 15, fontWeight: 600, margin: "22px 0 10px" }}>{children}</h2>
  );
}

function FieldRow({
  label,
  value,
  mono,
  last,
}: {
  label: string;
  value: string;
  mono?: boolean;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 16,
        padding: "12px 18px",
        borderBottom: last ? "none" : "1px solid var(--border-soft)",
        fontSize: 13,
      }}
    >
      <span style={{ width: 180, color: "var(--text-muted)" }}>{label}</span>
      <span className={mono ? "mono" : undefined} style={{ fontSize: mono ? 12.5 : 13 }}>
        {value}
      </span>
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.6px",
          textTransform: "uppercase",
          color: "var(--text-faint)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.7, padding: "10px 0 0" }}>
      {children}
    </p>
  );
}

const input: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
};

const ghost: CSSProperties = {
  background: "var(--surface)",
  color: "var(--text-mid)",
  border: "1px solid var(--border)",
  borderRadius: 11,
  fontSize: 12.5,
  padding: "8px 14px",
};

const accent: CSSProperties = {
  background: "var(--accent)",
  color: "var(--on-accent)",
  border: "none",
  borderRadius: 11,
  fontWeight: 600,
  fontSize: 12.5,
  padding: "8px 16px",
};
