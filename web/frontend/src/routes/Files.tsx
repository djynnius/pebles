import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { api, errorText, type User } from "../api";
import { InlineConfirm, InlinePanel, SmallButton, TextInput } from "../components/Form";
import { Switch } from "../components/Page";
import { ErrorBlock } from "../components/State";
import { FileIcon, fileKind } from "../components/FileIcon";
import { Workbench } from "../components/Workbench";

/*
 * /files — the workspace browser (spec §5 "workspace").
 *
 * Everything here runs as the signed-in UNIX user through their engine session
 * (REQ-11): the home directory *is* the workspace, and the API refuses any path
 * that escapes it.
 */

interface FileItem {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
}

type Section = "home" | "shared" | "workspace" | "favourites" | "trash";

const SECTIONS: { id: Section; label: string; glyph: string }[] = [
  { id: "home", label: "Home", glyph: "⌂" },
  { id: "shared", label: "Shared", glyph: "◫" },
  { id: "workspace", label: "Workspace", glyph: "▤" },
  { id: "favourites", label: "Favourites", glyph: "☆" },
  { id: "trash", label: "Trash", glyph: "⌫" },
];

/** Files Pebbles itself writes into a home and keeps (server answers 409). */
const MANAGED = new Set([".pgpass"]);

const HIDDEN_KEY = "pebbles.files.showHidden";

function readShowHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** The inline action in progress — the replacement for prompt()/confirm(). */
type Pending =
  | { kind: "delete"; item: FileItem }
  | { kind: "rename"; item: FileItem }
  | { kind: "mkdir" }
  | { kind: "newfile" };

interface Menu {
  x: number;
  y: number;
  item: FileItem;
}

export function Files({ user }: { user: User }) {
  const [section, setSection] = useState<Section>("home");
  const [path, setPath] = useState("");
  const [items, setItems] = useState<FileItem[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<Menu | null>(null);
  const [newMenu, setNewMenu] = useState(false);
  const [uploading, setUploading] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const [showHidden, setShowHidden] = useState(readShowHidden);
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingName, setPendingName] = useState("");
  const [pendingBusy, setPendingBusy] = useState(false);

  const toggleHidden = () =>
    setShowHidden((v) => {
      try {
        localStorage.setItem(HIDDEN_KEY, v ? "0" : "1");
      } catch {
        /* storage blocked — the toggle still works for this visit */
      }
      return !v;
    });

  const load = useCallback((p: string) => {
    setItems(null);
    setError("");
    api
      .get<{ path: string; items: FileItem[] }>(`/files?path=${encodeURIComponent(p)}`)
      .then((r) => setItems(r.items))
      // `items` stays null on failure so the table shows the error rather than
      // "This folder is empty." over a directory nobody could read.
      .catch((e) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    if (section === "home") load(path);
  }, [section, path, load]);

  // Dismiss both popovers on any click-away or Escape.
  useEffect(() => {
    if (!menu && !newMenu) return;
    const close = () => {
      setMenu(null);
      setNewMenu(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", key);
    };
  }, [menu, newMenu]);

  const rel = (name: string) => (path ? `${path}/${name}` : name);
  // Managed files live at the home root (e.g. ~/.pgpass).
  const managed = (item: FileItem) => path === "" && MANAGED.has(item.name);

  // Runs the pending action. Failures — including the 409 the server returns
  // for a Pebbles-managed file — land in the page's ErrorBlock.
  const act = (p: Promise<unknown>) => {
    setPendingBusy(true);
    setError("");
    return p
      .then(() => load(path))
      .catch((e) => setError(errorText(e)))
      .finally(() => {
        setPendingBusy(false);
        setPending(null);
      });
  };

  // Leaving a folder abandons any half-finished inline action.
  useEffect(() => setPending(null), [path, section]);

  const onDownload = (item: FileItem) => {
    window.open(`/api/files/download?path=${encodeURIComponent(rel(item.name))}`, "_blank");
  };
  const onRename = (item: FileItem) => {
    setPendingName(item.name);
    setPending({ kind: "rename", item });
  };
  const onDelete = (item: FileItem) => setPending({ kind: "delete", item });
  const onNewFolder = () => {
    setPendingName("");
    setPending({ kind: "mkdir" });
  };
  const onNewFile = () => {
    setPendingName("");
    setPending({ kind: "newfile" });
  };
  const submitPending = () => {
    if (!pending || pendingBusy) return;
    if (pending.kind === "delete") {
      void act(api.post("/files/delete", { path: rel(pending.item.name) }));
      return;
    }
    const name = pendingName.trim();
    if (!name) return;
    if (pending.kind === "rename") {
      if (name === pending.item.name) {
        setPending(null);
        return;
      }
      void act(
        api.post("/files/rename", { path: rel(pending.item.name), to: path ? `${path}/${name}` : name }),
      );
    } else if (pending.kind === "newfile") {
      void act(api.post("/files/new", { dir: path, name }));
    } else {
      void act(api.post("/files/mkdir", { dir: path, name }));
    }
  };
  const onUpload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const body = new FormData();
    body.append("dir", path);
    for (const f of Array.from(files)) body.append("file", f);
    setError("");
    setUploading(true);
    // Through api.upload, not a bare fetch: that path threw away the server's
    // {error} text ("upload failed") and skipped the central 401 handler.
    api
      .upload("/files/upload", body)
      .then(() => load(path))
      .catch((e) => setError(errorText(e)))
      .finally(() => setUploading(false));
  };

  const crumbs = path ? path.split("/") : [];
  const q = filter.trim().toLowerCase();
  const visible = (items ?? []).filter((i) => showHidden || !i.name.startsWith("."));
  const hiddenCount = (items?.length ?? 0) - visible.length;
  const shown = visible.filter((i) => !q || i.name.toLowerCase().includes(q));

  return (
    <Workbench
      rail={[{ id: "tree", icon: "folder", title: "Files" }]}
      defaultPanel="tree"
      panels={{
        tree: (
          <div style={{ padding: "8px 8px 14px" }}>
            {SECTIONS.map((s) => {
              const on = s.id === section;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    setSection(s.id);
                    if (s.id === "home") setPath("");
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    width: "100%",
                    textAlign: "left",
                    border: "none",
                    borderRadius: 8,
                    padding: "7px 10px",
                    fontSize: "var(--fs-body)",
                    fontFamily: "inherit",
                    fontWeight: on ? 600 : 400,
                    background: on ? "var(--accent-tint)" : "transparent",
                    color: on ? "var(--accent-tint-ink)" : "var(--text-mid)",
                  }}
                >
                  <span style={{ fontSize: "var(--fs-meta)", width: 12 }}>{s.glyph}</span>
                  {s.label}
                </button>
              );
            })}
            <div style={{ padding: "10px 10px 0", fontSize: "var(--fs-label)", color: "var(--text-dim)" }}>
              Right-click a file for actions
            </div>
          </div>
        ),
      }}
    >
      <div style={{ padding: "26px 32px 60px" }}>
        {section !== "home" ? (
          <SectionStub label={SECTIONS.find((s) => s.id === section)!.label} />
        ) : (
          <>
            {/* breadcrumb */}
            <div className="mono" style={{ fontSize: "var(--fs-small)", color: "var(--text-dim)", marginBottom: 10 }}>
              <button type="button" onClick={() => setPath("")} style={crumbBtn}>
                Home
              </button>
              {crumbs.map((c, i) => (
                <span key={i}>
                  <span style={{ margin: "0 6px", color: "var(--text-faint)" }}>›</span>
                  <button
                    type="button"
                    onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}
                    style={{ ...crumbBtn, color: i === crumbs.length - 1 ? "var(--text-mid)" : undefined }}
                  >
                    {c}
                  </button>
                </span>
              ))}
            </div>

            {/* title + actions */}
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 16,
                flexWrap: "wrap",
                marginBottom: 18,
              }}
            >
              <div style={{ flex: 1, minWidth: 220 }}>
                <h1 style={{ fontSize: "var(--fs-h2)", fontWeight: 600, letterSpacing: "-0.4px" }}>
                  {crumbs.length ? crumbs[crumbs.length - 1] : "Home"}
                </h1>
                <div className="mono" style={{ fontSize: "var(--fs-small)", color: "var(--text-dim)", marginTop: 4 }}>
                  /home/{user.username}
                  {path ? `/${path}` : ""} · uid {user.uid} ·{" "}
                  {items ? `${visible.length} item${visible.length === 1 ? "" : "s"}` : "…"}
                  {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, position: "relative" }}>
                <input
                  ref={upload}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    onUpload(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => upload.current?.click()}
                  disabled={uploading}
                  style={{ ...ghost, color: uploading ? "var(--text-faint)" : "var(--text-mid)" }}
                >
                  {uploading ? "Uploading…" : "Upload"}
                </button>
                <div style={{ position: "relative" }}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setNewMenu((v) => !v);
                    }}
                    style={{
                      background: "var(--accent)",
                      color: "var(--on-accent)",
                      border: "none",
                      borderRadius: 11,
                      fontWeight: 600,
                      fontSize: "var(--fs-body)",
                      padding: "8px 16px",
                    }}
                  >
                    New folder ▾
                  </button>
                  {newMenu && (
                    <div style={{ ...popover, top: 38, right: 0, position: "absolute" }}>
                      <MenuItem
                        label="Folder…"
                        onClick={() => {
                          setNewMenu(false);
                          onNewFolder();
                        }}
                      />
                      <MenuItem
                        label="New file…"
                        onClick={() => {
                          setNewMenu(false);
                          onNewFile();
                        }}
                      />
                      <MenuItem
                        label="Upload files…"
                        onClick={() => {
                          setNewMenu(false);
                          upload.current?.click();
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* filter + hidden-files toggle */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                flexWrap: "wrap",
                marginBottom: 14,
              }}
            >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                height: 32,
                flex: "0 1 320px",
                minWidth: 200,
                padding: "0 11px",
                borderRadius: 11,
                background: "var(--surface)",
                border: "1px solid var(--border)",
              }}
            >
              <span style={{ color: "var(--text-faint)", fontSize: "var(--fs-meta)" }}>⌕</span>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter files…"
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  background: "transparent",
                  color: "var(--text)",
                  fontSize: "var(--fs-body)",
                  outline: "none",
                }}
              />
            </div>
            <Switch label="Show hidden files" on={showHidden} onToggle={toggleHidden} />
            </div>

            {error && <ErrorBlock error={error} />}

            {pending?.kind === "delete" && (
              <InlineConfirm
                message={`Delete “${pending.item.name}”? This cannot be undone.`}
                confirmLabel="Delete"
                busyLabel="Deleting…"
                busy={pendingBusy}
                onConfirm={submitPending}
                onCancel={() => setPending(null)}
              />
            )}
            {(pending?.kind === "rename" || pending?.kind === "mkdir" || pending?.kind === "newfile") && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submitPending();
                }}
              >
                <InlinePanel>
                  <span style={{ color: "var(--text-mid)", flex: "0 0 auto" }}>
                    {pending.kind === "rename"
                      ? `Rename “${pending.item.name}” to`
                      : pending.kind === "newfile"
                        ? "New file"
                        : "New folder"}
                  </span>
                  <div style={{ flex: "1 1 220px", minWidth: 180 }}>
                    <TextInput
                      value={pendingName}
                      onChange={setPendingName}
                      autoFocus
                      ariaLabel={
                        pending.kind === "rename"
                          ? "New name"
                          : pending.kind === "newfile"
                            ? "File name"
                            : "Folder name"
                      }
                      placeholder={
                        pending.kind === "rename"
                          ? undefined
                          : pending.kind === "newfile"
                            ? "analysis.py"
                            : "folder-name"
                      }
                      style={{ padding: "6px 10px", borderRadius: 9 }}
                    />
                  </div>
                  <SmallButton type="submit" primary disabled={pendingBusy || !pendingName.trim()}>
                    {pendingBusy
                      ? pending.kind === "rename"
                        ? "Renaming…"
                        : "Creating…"
                      : pending.kind === "rename"
                        ? "Rename"
                        : "Create"}
                  </SmallButton>
                  <SmallButton disabled={pendingBusy} onClick={() => setPending(null)}>
                    Cancel
                  </SmallButton>
                </InlinePanel>
              </form>
            )}
            {pending && <div style={{ height: 14 }} />}

            <div
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 14,
                overflow: "hidden",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Name", "Type", "Owner", "Last updated", ""].map((h, i) => (
                      <th key={i} style={th}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((item) => (
                    <tr
                      key={item.name}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, item });
                      }}
                    >
                      <td style={td}>
                        <button
                          type="button"
                          onClick={() => item.dir && setPath(rel(item.name))}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 9,
                            border: "none",
                            background: "transparent",
                            padding: 0,
                            fontFamily: "inherit",
                            fontSize: "var(--fs-base)",
                            color: "var(--text)",
                            cursor: item.dir ? "pointer" : "default",
                          }}
                        >
                          <FileIcon kind={fileKind(item.name, item.dir, path)} />
                          {item.name}
                          {managed(item) && (
                            <span
                              title="Managed by Pebbles — can't be renamed or deleted"
                              style={{
                                padding: "1px 7px",
                                borderRadius: 20,
                                background: "var(--track)",
                                color: "var(--text-dim)",
                                fontSize: "var(--fs-xs)",
                                fontWeight: 600,
                                letterSpacing: "0.3px",
                              }}
                            >
                              managed
                            </span>
                          )}
                        </button>
                      </td>
                      <td style={{ ...td, color: "var(--text-dim)" }}>
                        {item.dir ? "folder" : ext(item.name)}
                      </td>
                      <td style={td}>{user.username}</td>
                      <td style={{ ...td, color: "var(--text-dim)" }}>
                        {new Date(item.mtime * 1000).toLocaleString()}
                        {!item.dir && (
                          <span style={{ marginLeft: 8, fontSize: "var(--fs-small)" }}>{size(item.size)}</span>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: "right", width: 40 }}>
                        <button
                          type="button"
                          aria-label={`Actions for ${item.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            const r = (e.target as HTMLElement).getBoundingClientRect();
                            setMenu({ x: r.left - 130, y: r.bottom + 4, item });
                          }}
                          style={{
                            border: "none",
                            background: "transparent",
                            color: "var(--text-faint)",
                            fontSize: "var(--fs-md)",
                            padding: "0 4px",
                          }}
                        >
                          ⋯
                        </button>
                      </td>
                    </tr>
                  ))}
                  {items !== null && shown.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ ...td, color: "var(--text-dim)" }}>
                        {items.length === 0
                          ? "This folder is empty — Upload, or New folder ▾, to fill it."
                          : visible.length === 0
                            ? "Only hidden files here — turn on Show hidden files to see them."
                            : "Nothing matches the filter."}
                      </td>
                    </tr>
                  )}
                  {items === null && (
                    <tr>
                      <td colSpan={5} style={{ ...td, color: "var(--text-dim)" }}>
                        {error ? "Nothing to show — see the message above." : "Loading…"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {menu && (
        <div
          style={{ ...popover, position: "fixed", left: menu.x, top: menu.y, zIndex: 60 }}
          onClick={(e) => e.stopPropagation()}
        >
          {!menu.item.dir && (
            <MenuItem
              label="Download"
              onClick={() => {
                onDownload(menu.item);
                setMenu(null);
              }}
            />
          )}
          {!managed(menu.item) && (
            <>
              <MenuItem
                label="Rename…"
                onClick={() => {
                  const it = menu.item;
                  setMenu(null);
                  onRename(it);
                }}
              />
              <MenuItem
                label="Delete"
                danger
                onClick={() => {
                  const it = menu.item;
                  setMenu(null);
                  onDelete(it);
                }}
              />
            </>
          )}
          {managed(menu.item) && (
            <div style={{ padding: "8px 14px", fontSize: "var(--fs-small)", color: "var(--text-dim)" }}>
              Managed by Pebbles
            </div>
          )}
        </div>
      )}
    </Workbench>
  );
}

function MenuItem({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        border: "none",
        background: "transparent",
        padding: "8px 14px",
        fontSize: "var(--fs-body)",
        fontFamily: "inherit",
        color: danger ? "var(--err)" : "var(--text-mid)",
      }}
    >
      {label}
    </button>
  );
}

function SectionStub({ label }: { label: string }) {
  return (
    <div style={{ maxWidth: 420, margin: "90px auto 0", textAlign: "center" }}>
      <div style={{ fontSize: "var(--fs-lg)", fontWeight: 600, marginBottom: 6 }}>{label} is empty</div>
      <div style={{ fontSize: "var(--fs-body)", color: "var(--text-dim)" }}>
        Only your home directory is live today — {label.toLowerCase()} arrives with sharing.
      </div>
    </div>
  );
}

const ext = (name: string) => {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : "file";
};

const size = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  return `${n < 10 && u > 0 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
};

const popover: CSSProperties = {
  minWidth: 150,
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 11,
  boxShadow: "0 8px 26px rgba(20,22,16,.22)",
  padding: "5px 0",
  zIndex: 40,
};

const crumbBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  fontSize: "var(--fs-small)",
  color: "var(--text-dim)",
};

const th: CSSProperties = {
  textAlign: "left",
  background: "var(--surface-alt)",
  borderBottom: "1px solid var(--border)",
  fontSize: "var(--fs-label)",
  fontWeight: 600,
  letterSpacing: "0.5px",
  textTransform: "uppercase",
  color: "var(--text-faint)",
  padding: "10px 16px",
};

const td: CSSProperties = {
  padding: "10px 16px",
  borderBottom: "1px solid var(--border-soft)",
  fontSize: "var(--fs-base)",
};

const ghost: CSSProperties = {
  background: "var(--surface)",
  color: "var(--text-mid)",
  border: "1px solid var(--border)",
  borderRadius: 11,
  fontSize: "var(--fs-body)",
  padding: "8px 14px",
};
