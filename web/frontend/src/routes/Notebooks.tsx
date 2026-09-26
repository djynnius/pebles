import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorText } from "../api";
import { AccentButton, GhostButton, Page } from "../components/Page";
import { InlineConfirm } from "../components/Form";
import { Empty, ErrorBlock, Loading } from "../components/State";

/*
 * /notebooks — the notebook index (spec §5 "notebook" is the document itself;
 * this is its list). Notebooks are JSON documents in the signed-in user's home
 * (~/notebooks/<name>.json), created and deleted through the session broker —
 * Flask never touches the filesystem itself (NFR-01).
 */

/** Server-side rule, mirrored so the form can refuse before the round trip. */
export const DOC_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function Notebooks() {
  const nav = useNavigate();
  const [names, setNames] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");

  const load = useCallback(() => {
    setError("");
    api
      .get<string[]>("/notebooks")
      // `names` stays null on failure: an unreadable home is not an empty one,
      // and "No notebooks yet" would be a lie while pebblesd is restarting.
      .catch((e) => {
        setError(errorText(e));
        return null;
      })
      .then((list) => list && setNames(list));
  }, []);

  useEffect(load, [load]);

  const create = () => {
    const n = name.trim();
    if (!DOC_NAME.test(n)) {
      setError("Use lower-case letters, digits, dash or underscore (max 64).");
      return;
    }
    setBusy(true);
    setError("");
    api
      .post(`/notebooks`, { name: n })
      .then(() => nav(`/notebooks/${encodeURIComponent(n)}`))
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  /**
   * .ipynb import: the server converts, names the notebook after the file
   * (or the name typed in the field, when valid), and refuses to overwrite —
   * its 409/422 sentences are shown as-is.
   */
  const importFile = (file: File) => {
    const body = new FormData();
    body.append("file", file);
    const n = name.trim();
    if (n && DOC_NAME.test(n)) body.append("name", n);
    setImporting(true);
    setImportError("");
    api
      .upload<{ name: string; cells: number }>("/notebooks/import", body)
      .then((r) => nav(`/notebooks/${encodeURIComponent(r.name)}`))
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
      .del(`/notebooks/${encodeURIComponent(confirming)}`)
      .then(() => {
        setConfirming(null);
        load();
      })
      .catch((e) => setDeleteError(errorText(e)))
      .finally(() => setDeleting(false));
  };

  return (
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
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: 14,
          marginBottom: 18,
        }}
      >
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
            fontSize: 12.5,
            outline: "none",
          }}
        />
        <AccentButton onClick={busy ? undefined : create}>
          {busy ? "Creating…" : "New notebook"}
        </AccentButton>
      </div>

      {importError && <ErrorBlock title="Couldn't import that notebook" error={importError} />}
      {error && <ErrorBlock error={error} />}
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
                      onClick={() => nav(`/notebooks/${encodeURIComponent(n)}`)}
                      className="mono"
                      style={{
                        border: "none",
                        background: "transparent",
                        padding: 0,
                        fontSize: 13,
                        fontWeight: 500,
                        color: "var(--text)",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <span style={{ color: "var(--text-faint)" }}>▧</span>
                      {n}
                    </button>
                  </td>
                  <td className="mono" style={{ ...td, color: "var(--text-dim)", fontSize: 11.5 }}>
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
                        fontSize: 12,
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
        names !== null && (
          <Empty
            glyph="▧"
            title="No notebooks yet"
            body="Notebooks are JSON documents in your own home — SQL, Python and R cells that run on your engine session as you, plus markdown notes. Import a Jupyter .ipynb to start from one you have."
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
                  fontSize: 13,
                  padding: "9px 18px",
                }}
              >
                Name your first notebook
              </button>
            }
          />
        )
      )}
    </Page>
  );
}

const th: CSSProperties = {
  textAlign: "left",
  background: "var(--surface-alt)",
  borderBottom: "1px solid var(--border)",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.5px",
  textTransform: "uppercase",
  color: "var(--text-faint)",
  padding: "10px 16px",
};

const td: CSSProperties = {
  padding: "10px 16px",
  borderBottom: "1px solid var(--border-soft)",
  fontSize: 13,
};
