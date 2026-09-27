import { useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, errorText } from "../api";
import { AccentButton, GhostButton, Page } from "../components/Page";
import { InlineConfirm } from "../components/Form";
import { Empty, ErrorBlock, Loading } from "../components/State";
import { FileIcon } from "../components/FileIcon";
import { WorkspaceTree } from "../components/WorkspaceTree";
import {
  displayFolder,
  joinPath,
  leafOf,
  notebookApi,
  notebookUrl,
  parentOf,
  pathProblem,
  useNotebookTree,
} from "../notebooks";

/*
 * /notebooks — the notebook index (spec §5 "notebook" is the document itself;
 * this is its list). Notebooks are JSON documents in the signed-in user's home
 * under ~/notebooks, in folders (Databricks-style workspace): a notebook's
 * name is its relative path, e.g. `projects/hedis/q1-review`. They are created
 * and deleted through the session broker — Flask never touches the filesystem
 * itself (NFR-01).
 *
 * Left: the workspace tree. The selected folder (`?folder=`) filters the list
 * and is where New notebook / Import .ipynb put things.
 */

/** Server-side rule for dashboard names (and each notebook path segment). */
export const DOC_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function Notebooks() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const folder = (params.get("folder") ?? "").replace(/^\/+|\/+$/g, "");
  const setFolder = (f: string) => setParams(f ? { folder: f } : {}, { replace: true });

  const { tree, error, reload } = useNotebookTree();
  const [formError, setFormError] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");

  /** Notebooks at or below the selected folder, in path order. */
  const names = useMemo(() => {
    if (!tree) return null;
    const inFolder = folder ? tree.notebooks.filter((n) => n.startsWith(`${folder}/`)) : tree.notebooks;
    return [...inFolder].sort();
  }, [tree, folder]);

  const typed = name.trim().replace(/^\/+|\/+$/g, "");
  const target = typed ? joinPath(folder, typed) : "";

  const create = () => {
    const problem = typed ? pathProblem(target) : "Name the notebook first.";
    if (problem) {
      setFormError(problem);
      return;
    }
    setBusy(true);
    setFormError("");
    api
      .post(`/notebooks`, { name: target })
      .then(() => nav(notebookUrl(target)))
      .catch((e) => setFormError(errorText(e)))
      .finally(() => setBusy(false));
  };

  /**
   * .ipynb import: the server converts, names the notebook after the file
   * (or the name typed in the field, when valid) inside the selected folder,
   * and refuses to overwrite — its 409/422 sentences are shown as-is.
   */
  const importFile = (file: File) => {
    const body = new FormData();
    body.append("file", file);
    if (typed && !pathProblem(target)) body.append("name", target);
    else if (folder) body.append("folder", folder);
    setImporting(true);
    setImportError("");
    api
      .upload<{ name: string; cells: number }>("/notebooks/import", body)
      .then((r) => nav(notebookUrl(r.name)))
      .catch((e) => setImportError(errorText(e)))
      .finally(() => setImporting(false));
  };

  // Inline "Delete x? [Delete] [Cancel]" instead of window.confirm.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const remove = (n: string) => {
    setConfirming(n);
    setDeleteError("");
  };

  const confirmRemove = () => {
    if (!confirming) return;
    setDeleting(true);
    setDeleteError("");
    api
      .del(notebookApi(confirming))
      .then(() => {
        setConfirming(null);
        reload();
      })
      .catch((e) => setDeleteError(errorText(e)))
      .finally(() => setDeleting(false));
  };

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* ---- workspace tree ------------------------------------------------ */}
      <aside
        aria-label="Workspace"
        style={{
          width: 270,
          flex: "0 0 270px",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background: "var(--surface)",
          borderRight: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            padding: "12px 14px 8px",
            fontSize: "var(--fs-eyebrow)",
            fontWeight: 600,
            letterSpacing: "0.8px",
            textTransform: "uppercase",
            color: "var(--text-faint)",
            borderBottom: "1px solid var(--border-soft)",
          }}
        >
          Workspace
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          <WorkspaceTree
            tree={tree}
            error={error}
            reload={reload}
            selectedFolder={folder}
            onSelectFolder={setFolder}
          />
        </div>
      </aside>

      {/* ---- list + create -------------------------------------------------- */}
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        <Page
          title="Notebooks"
          eyebrow="Analysis"
          actions={
            <>
              <input
                ref={picker}
                type="file"
                accept=".ipynb,application/x-ipynb+json,application/json"
                aria-label="Import .ipynb file"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = ""; // picking the same file again must re-fire
                  if (f) importFile(f);
                }}
              />
              <GhostButton disabled={importing} onClick={() => picker.current?.click()}>
                {importing ? "Importing…" : "Import .ipynb"}
              </GhostButton>
            </>
          }
        >
          {/* new notebook */}
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 14,
              padding: 14,
              marginBottom: 18,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <input
                ref={field}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") create();
                }}
                placeholder="claims-exploration"
                aria-label="New notebook name"
                className="mono"
                style={{
                  flex: 1,
                  minWidth: 200,
                  height: 34,
                  padding: "0 12px",
                  borderRadius: 11,
                  border: "1px solid var(--border)",
                  background: "var(--surface-alt)",
                  color: "var(--text)",
                  fontSize: "var(--fs-body)",
                  outline: "none",
                }}
              />
              <AccentButton onClick={busy ? undefined : create}>
                {busy ? "Creating…" : "New notebook"}
              </AccentButton>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginTop: 9,
                fontSize: "var(--fs-small)",
                color: "var(--text-dim)",
              }}
            >
              <FileIcon kind="folder" size={14} />
              <span>
                Creates in <span className="mono" style={{ color: "var(--text-mid)" }}>{displayFolder(folder)}</span>
                {typed && !pathProblem(target) && (
                  <>
                    {" "}
                    as <span className="mono" style={{ color: "var(--text-mid)" }}>{leafOf(target)}.json</span>
                  </>
                )}
                {" "}— imports go there too. Pick another folder on the left.
              </span>
            </div>
          </div>

          {formError && <ErrorBlock error={formError} />}
          {importError && <ErrorBlock title="Couldn't import that notebook" error={importError} />}
          {error && !tree && <ErrorBlock error={error} />}
          {!error && names === null && <Loading />}
          {confirming && (
            <div style={{ marginBottom: 14 }}>
              <InlineConfirm
                message={`Delete notebook “${confirming}”? This removes ~/notebooks/${confirming}.json.`}
                confirmLabel="Delete"
                busyLabel="Deleting…"
                busy={deleting}
                error={deleteError}
                onConfirm={confirmRemove}
                onCancel={() => setConfirming(null)}
              />
            </div>
          )}

          {names && names.length > 0 ? (
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
                    <th style={th}>Notebook</th>
                    <th style={th}>Folder</th>
                    <th style={th}>Path</th>
                    <th style={{ ...th, width: 60 }} />
                  </tr>
                </thead>
                <tbody>
                  {names.map((n) => (
                    <tr key={n}>
                      <td style={td}>
                        <button
                          type="button"
                          onClick={() => nav(notebookUrl(n))}
                          className="mono"
                          style={{
                            border: "none",
                            background: "transparent",
                            padding: 0,
                            fontSize: "var(--fs-base)",
                            fontWeight: 500,
                            color: "var(--text)",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <FileIcon kind="notebook" size={15} />
                          {leafOf(n)}
                        </button>
                      </td>
                      <td className="mono" style={{ ...td, fontSize: "var(--fs-small)" }}>
                        <button
                          type="button"
                          title={`Show ${displayFolder(parentOf(n))}`}
                          onClick={() => setFolder(parentOf(n))}
                          style={{
                            border: "none",
                            background: "transparent",
                            padding: 0,
                            font: "inherit",
                            color: "var(--text-mid)",
                          }}
                        >
                          {parentOf(n) || "/"}
                        </button>
                      </td>
                      <td className="mono" style={{ ...td, color: "var(--text-dim)", fontSize: "var(--fs-small)" }}>
                        ~/notebooks/{n}.json
                      </td>
                      <td style={{ ...td, textAlign: "right" }}>
                        <button
                          type="button"
                          title={`Delete ${n}`}
                          aria-label={`Delete ${n}`}
                          onClick={() => remove(n)}
                          style={{
                            border: "none",
                            background: "transparent",
                            color: "var(--text-faint)",
                            fontSize: "var(--fs-meta)",
                            padding: "2px 6px",
                            borderRadius: 6,
                          }}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            names !== null &&
            (folder ? (
              <Empty
                glyph="▧"
                title={`No notebooks in ${displayFolder(folder)}`}
                body="Name one above to create it here, or import a Jupyter .ipynb into this folder."
              />
            ) : (
              <Empty
                glyph="▧"
                title="No notebooks yet"
                body="Notebooks are JSON documents in your own home — SQL, Python and R cells that run on your engine session as you, plus markdown notes. Organise them in folders on the left, or import a Jupyter .ipynb to start from one you have."
                action={
                  <button
                    type="button"
                    onClick={() => field.current?.focus()}
                    style={{
                      background: "var(--accent)",
                      color: "var(--on-accent)",
                      border: "none",
                      borderRadius: 11,
                      fontWeight: 600,
                      fontSize: "var(--fs-base)",
                      padding: "9px 18px",
                    }}
                  >
                    Name your first notebook
                  </button>
                }
              />
            ))
          )}
        </Page>
      </div>
    </div>
  );
}

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
