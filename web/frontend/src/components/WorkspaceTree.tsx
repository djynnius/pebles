import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api, errorText } from "../api";
import {
  displayFolder,
  joinPath,
  leafOf,
  notebookUrl,
  parentOf,
  pathProblem,
  type NotebookTree,
} from "../notebooks";
import { ContextMenu, Dialog, DialogActions, type MenuEntry } from "./Dialog";
import { FileIcon } from "./FileIcon";
import { Field, FormMessage, SmallButton, TextInput } from "./Form";

/*
 * The notebook workspace (~/notebooks) as a tree — folders first, then
 * notebooks — shared by the Notebooks index (left column) and the notebook
 * workbench panel (under the table of contents).
 *
 * Folder rows select a target folder (when `onSelectFolder` is given) and
 * toggle open; notebook rows open the notebook. Right-click offers Open /
 * Rename / Delete (+ New folder on folders), all through in-app dialogs.
 * Rename and delete go through the generic Files API with home-relative paths
 * (`notebooks/<path>.json`, `notebooks/<folder>`); a rename can also move, by
 * editing the folder part of the path.
 */

type Target = { kind: "notebook"; path: string } | { kind: "folder"; path: string };

type Pending =
  | { kind: "rename"; target: Target }
  | { kind: "delete"; target: Target }
  | { kind: "mkdir"; parent: string };

/** Home-relative path the Files API understands. */
const homePath = (t: Target) => (t.kind === "notebook" ? `notebooks/${t.path}.json` : `notebooks/${t.path}`);

/** The Files API answers 200 `{ok:false, error}` for a failed session op. */
async function fileOp(path: string, body: Record<string, string>): Promise<void> {
  const r = await api.post<{ ok?: boolean; error?: string }>(path, body);
  if (r && r.ok === false) throw new Error(r.error || "The operation failed.");
}

/** `a/b/c` → [`a`, `a/b`] (the folders above, outermost first). */
function ancestors(path: string): string[] {
  const segs = path.split("/");
  return segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join("/"));
}

export function WorkspaceTree({
  tree,
  error,
  reload,
  current,
  selectedFolder,
  onSelectFolder,
  onChanged,
  onOpen,
  showToolbar = true,
}: {
  tree: NotebookTree | null;
  error: string;
  reload: () => void;
  /** The open notebook — highlighted, its folders expanded. */
  current?: string;
  /** The folder new things go into ("" = the workspace root). */
  selectedFolder?: string;
  onSelectFolder?: (folder: string) => void;
  /** Fires after any rename / delete / mkdir succeeded. */
  onChanged?: () => void;
  /** Opens a notebook; defaults to navigating (a notebook page saves first). */
  onOpen?: (path: string) => void;
  showToolbar?: boolean;
}) {
  const nav = useNavigate();
  const openNotebook = (path: string) => (onOpen ? onOpen(path) : nav(notebookUrl(path)));
  const [open, setOpen] = useState<Set<string>>(() => new Set(current ? ancestors(current) : []));
  const [menu, setMenu] = useState<{ target: Target | null; x: number; y: number } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  // Opening another notebook (or selecting a deep folder) reveals it.
  useEffect(() => {
    const reveal = [
      ...(current ? ancestors(current) : []),
      ...(selectedFolder ? [...ancestors(selectedFolder), selectedFolder] : []),
    ];
    if (reveal.length === 0) return;
    setOpen((cur) => (reveal.every((f) => cur.has(f)) ? cur : new Set([...cur, ...reveal])));
  }, [current, selectedFolder]);

  /** children[folder] = { folders, notebooks }, both sorted. */
  const children = useMemo(() => {
    const map = new Map<string, { folders: string[]; notebooks: string[] }>();
    const slot = (f: string) => {
      let s = map.get(f);
      if (!s) {
        s = { folders: [], notebooks: [] };
        map.set(f, s);
      }
      return s;
    };
    slot("");
    // Folders implied by a notebook path count even if the server omitted them.
    const folders = new Set(tree?.folders ?? []);
    for (const n of tree?.notebooks ?? []) for (const a of ancestors(n)) folders.add(a);
    for (const f of folders) {
      for (const a of ancestors(f)) folders.add(a);
    }
    for (const f of folders) slot(parentOf(f)).folders.push(f);
    for (const n of tree?.notebooks ?? []) slot(parentOf(n)).notebooks.push(n);
    for (const s of map.values()) {
      s.folders.sort();
      s.notebooks.sort();
    }
    return map;
  }, [tree]);

  const toggle = (f: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  const clickFolder = (f: string) => {
    if (onSelectFolder) {
      // First click selects; clicking the selected folder again toggles it.
      if (selectedFolder === f) toggle(f);
      else {
        onSelectFolder(f);
        setOpen((cur) => new Set([...cur, f]));
      }
    } else toggle(f);
  };

  const openMenu = (e: ReactMouseEvent, target: Target | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ target, x: e.clientX, y: e.clientY });
  };

  const menuItems = (t: Target | null): MenuEntry[] => {
    if (!t) return [{ label: "New folder…", onSelect: () => setPending({ kind: "mkdir", parent: "" }) }];
    if (t.kind === "notebook") {
      return [
        { label: "Open", onSelect: () => openNotebook(t.path) },
        { label: "Rename…", onSelect: () => setPending({ kind: "rename", target: t }) },
        { label: "Delete…", danger: true, onSelect: () => setPending({ kind: "delete", target: t }) },
      ];
    }
    return [
      {
        label: "Open",
        onSelect: () => {
          onSelectFolder?.(t.path);
          setOpen((cur) => new Set([...cur, ...ancestors(t.path), t.path]));
        },
      },
      { label: "New folder…", onSelect: () => setPending({ kind: "mkdir", parent: t.path }) },
      { label: "Rename…", onSelect: () => setPending({ kind: "rename", target: t }) },
      { label: "Delete…", danger: true, onSelect: () => setPending({ kind: "delete", target: t }) },
    ];
  };

  /** After a successful change: re-read, follow the open notebook if it moved. */
  const settled = (p: Pending, to?: string) => {
    setPending(null);
    reload();
    onChanged?.();
    if (p.kind === "mkdir") {
      if (to !== undefined) onSelectFolder?.(to);
      return;
    }
    const t = p.target;
    const inside = (path: string | undefined) =>
      path !== undefined && (t.kind === "notebook" ? path === t.path : path === t.path || path.startsWith(`${t.path}/`));
    if (p.kind === "rename" && to !== undefined) {
      if (inside(current) && current) {
        nav(notebookUrl(to + current.slice(t.path.length)), { replace: true });
      }
      if (t.kind === "folder" && inside(selectedFolder) && selectedFolder !== undefined) {
        onSelectFolder?.(to + selectedFolder.slice(t.path.length));
      }
    } else if (p.kind === "delete") {
      if (inside(current)) nav("/notebooks");
      if (t.kind === "folder" && inside(selectedFolder)) onSelectFolder?.(parentOf(t.path));
    }
  };

  const root = children.get("") ?? { folders: [], notebooks: [] };
  const empty = root.folders.length === 0 && root.notebooks.length === 0;
  const newFolderParent = selectedFolder ?? (current ? parentOf(current) : "");

  const renderFolder = (folder: string, depth: number): ReactElement[] => {
    const kids = children.get(folder) ?? { folders: [], notebooks: [] };
    const out: ReactElement[] = [];
    for (const f of kids.folders) {
      const isOpen = open.has(f);
      const sel = selectedFolder === f;
      out.push(
        <div
          key={`f:${f}`}
          role="treeitem"
          aria-expanded={isOpen}
          aria-selected={sel}
          tabIndex={0}
          title={displayFolder(f)}
          onClick={() => clickFolder(f)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              clickFolder(f);
            }
          }}
          onContextMenu={(e) => openMenu(e, { kind: "folder", path: f })}
          style={{ ...row, paddingLeft: 8 + depth * 14, ...(sel ? rowSelected : null) }}
        >
          <button
            type="button"
            aria-label={isOpen ? `Collapse ${leafOf(f)}` : `Expand ${leafOf(f)}`}
            onClick={(e) => {
              e.stopPropagation();
              toggle(f);
            }}
            style={caret}
          >
            {isOpen ? "▾" : "▸"}
          </button>
          <FileIcon kind="folder" size={15} />
          <span style={label}>{leafOf(f)}</span>
        </div>,
      );
      if (isOpen) out.push(...renderFolder(f, depth + 1));
    }
    for (const n of kids.notebooks) {
      const on = current === n;
      out.push(
        <div
          key={`n:${n}`}
          role="treeitem"
          aria-selected={on}
          aria-current={on ? "page" : undefined}
          tabIndex={0}
          title={`~/notebooks/${n}.json`}
          onClick={() => !on && openNotebook(n)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !on) openNotebook(n);
          }}
          onContextMenu={(e) => openMenu(e, { kind: "notebook", path: n })}
          style={{ ...row, paddingLeft: 8 + depth * 14 + 18, ...(on ? rowCurrent : null) }}
        >
          <FileIcon kind="notebook" size={15} />
          <span className="mono" style={{ ...label, fontWeight: on ? 600 : 400 }}>
            {leafOf(n)}
          </span>
        </div>,
      );
    }
    return out;
  };

  return (
    <div onContextMenu={(e) => openMenu(e, null)} style={{ paddingBottom: 8 }}>
      {showToolbar && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px 4px" }}>
          <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: "var(--fs-label)", color: "var(--text-dim)", ...ellipsis }}>
            ~/notebooks
          </span>
          <button
            type="button"
            title={`New folder in ${displayFolder(newFolderParent)}`}
            onClick={() => setPending({ kind: "mkdir", parent: newFolderParent })}
            style={toolBtn}
          >
            + Folder
          </button>
          <button type="button" title="Refresh" aria-label="Refresh workspace" onClick={reload} style={toolBtn}>
            ↻
          </button>
        </div>
      )}

      {/* the root */}
      <div
        role="treeitem"
        aria-selected={selectedFolder === ""}
        tabIndex={0}
        title="~/notebooks"
        onClick={() => onSelectFolder?.("")}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSelectFolder?.("");
        }}
        onContextMenu={(e) => openMenu(e, null)}
        style={{
          ...row,
          paddingLeft: 8,
          cursor: onSelectFolder ? "pointer" : "default",
          ...(selectedFolder === "" ? rowSelected : null),
        }}
      >
        <span style={{ ...caret, cursor: "default" }}>▾</span>
        <FileIcon kind="folder" size={15} />
        <span style={{ ...label, fontWeight: 600 }}>Workspace</span>
      </div>

      <div role="tree" aria-label="Notebook workspace">
        {error && !tree && (
          <div style={{ padding: "6px 12px", fontSize: "var(--fs-meta)", color: "var(--err)" }}>{error}</div>
        )}
        {!error && !tree && (
          <div style={{ padding: "6px 12px 6px 30px", fontSize: "var(--fs-meta)", color: "var(--text-dim)" }}>
            Loading…
          </div>
        )}
        {tree && empty && (
          <div style={{ padding: "6px 12px 6px 30px", fontSize: "var(--fs-meta)", color: "var(--text-dim)" }}>
            Empty — new notebooks land here.
          </div>
        )}
        {tree && renderFolder("", 1)}
      </div>

      {/* Portalled: inside the workbench panel these would be trapped in the
          panel's stacking context, under the icon rail. */}
      {menu &&
        createPortal(
        <ContextMenu
          x={menu.x}
          y={menu.y}
          header={menu.target ? (menu.target.kind === "notebook" ? `~/notebooks/${menu.target.path}.json` : displayFolder(menu.target.path)) : "~/notebooks"}
          items={menuItems(menu.target)}
          onClose={() => setMenu(null)}
        />,
          document.body,
        )}

      {pending &&
        createPortal(
          <WorkspaceDialog pending={pending} onClose={() => setPending(null)} onDone={(to) => settled(pending, to)} />,
          document.body,
        )}
    </div>
  );
}

/* ---- rename / delete / new-folder dialog -------------------------------- */

function WorkspaceDialog({
  pending,
  onClose,
  onDone,
}: {
  pending: Pending;
  onClose: () => void;
  /** `to` = the new path (rename, mkdir). */
  onDone: (to?: string) => void;
}) {
  const [value, setValue] = useState(pending.kind === "rename" ? pending.target.path : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const isDelete = pending.kind === "delete";
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  const fullPath = pending.kind === "mkdir" ? joinPath(pending.parent, trimmed) : trimmed;
  const kind = pending.kind === "mkdir" ? "folder" : pending.target.kind;
  const problem = isDelete || !trimmed ? "" : pathProblem(fullPath, kind);
  const unchanged = pending.kind === "rename" && trimmed === pending.target.path;
  const movesIntoItself =
    pending.kind === "rename" &&
    pending.target.kind === "folder" &&
    trimmed.startsWith(`${pending.target.path}/`);
  const canSubmit = !busy && (isDelete || (trimmed !== "" && !problem && !unchanged && !movesIntoItself));

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      if (pending.kind === "delete") {
        await fileOp("/files/delete", { path: homePath(pending.target) });
        onDone();
      } else if (pending.kind === "rename") {
        const t = pending.target;
        const to = t.kind === "notebook" ? `notebooks/${trimmed}.json` : `notebooks/${trimmed}`;
        await fileOp("/files/rename", { path: homePath(t), to });
        onDone(trimmed);
      } else {
        await api.post("/notebooks/folders", { path: fullPath });
        onDone(fullPath);
      }
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const title =
    pending.kind === "mkdir"
      ? "New folder"
      : pending.kind === "rename"
        ? `Rename ${pending.target.kind}`
        : `Delete ${pending.target.kind}`;

  return (
    <Dialog title={title} onClose={() => !busy && onClose()} width={460}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        style={{ display: "grid", gap: 14 }}
      >
        {pending.kind === "delete" ? (
          <div style={{ fontSize: "var(--fs-body)", color: "var(--text)", lineHeight: 1.55 }}>
            {pending.target.kind === "notebook" ? (
              <>
                Delete <span className="mono">~/notebooks/{pending.target.path}.json</span>? This can&apos;t be
                undone.
              </>
            ) : (
              <>
                Delete the folder <span className="mono">{displayFolder(pending.target.path)}</span> and every
                notebook inside it? This can&apos;t be undone.
              </>
            )}
          </div>
        ) : (
          <>
            <div className="mono" style={{ fontSize: "var(--fs-small)", color: "var(--text-dim)" }}>
              {pending.kind === "mkdir"
                ? `in ${displayFolder(pending.parent)}`
                : `${pending.target.kind === "notebook" ? `~/notebooks/${pending.target.path}.json` : displayFolder(pending.target.path)}`}
            </div>
            <Field
              label={pending.kind === "mkdir" ? "Folder name" : "New path in ~/notebooks"}
              hint={
                pending.kind === "mkdir"
                  ? "Lower-case letters, digits, dash or underscore."
                  : "Edit the folder part to move it, e.g. projects/hedis/q1-review."
              }
            >
              <TextInput value={value} onChange={setValue} autoFocus ariaLabel="Name" placeholder="hedis" />
            </Field>
          </>
        )}

        {problem && <FormMessage tone="err">{problem}</FormMessage>}
        {movesIntoItself && <FormMessage tone="err">A folder can&apos;t move inside itself.</FormMessage>}
        {error && <FormMessage tone="err">{error}</FormMessage>}

        <DialogActions>
          <SmallButton onClick={onClose} disabled={busy}>
            Cancel
          </SmallButton>
          <SmallButton type="submit" primary danger={isDelete} disabled={!canSubmit}>
            {busy
              ? pending.kind === "delete"
                ? "Deleting…"
                : pending.kind === "rename"
                  ? "Renaming…"
                  : "Creating…"
              : pending.kind === "delete"
                ? "Delete"
                : pending.kind === "rename"
                  ? "Rename"
                  : "Create folder"}
          </SmallButton>
        </DialogActions>
      </form>
    </Dialog>
  );
}

const ellipsis: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 10px 4px 8px",
  margin: "0 6px",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: "var(--fs-body)",
  color: "var(--text-mid)",
  userSelect: "none",
};

const rowSelected: CSSProperties = { background: "var(--track)", color: "var(--text)" };
const rowCurrent: CSSProperties = { background: "var(--accent-tint)", color: "var(--accent-tint-ink)" };

const label: CSSProperties = { flex: 1, minWidth: 0, ...ellipsis };

const caret: CSSProperties = {
  width: 14,
  flexShrink: 0,
  border: "none",
  background: "transparent",
  padding: 0,
  color: "var(--text-faint)",
  fontSize: "var(--fs-xs)",
  lineHeight: 1,
  textAlign: "center",
};

const toolBtn: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--surface)",
  color: "var(--text-muted)",
  fontFamily: "inherit",
  fontSize: "var(--fs-label)",
  padding: "2px 8px",
};
