import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { api } from "../api";
import {
  accessDenied,
  type AccessDenied,
  type Catalog,
  type SchemaNode,
  type TreeResponse,
} from "../catalogs";

/*
 * catalog › schema › table tree, shared by the Catalog browser's 290px column
 * and the SQL editor's 266px context panel. Schemas/tables are fetched lazily
 * per catalog on first expand (each /tree call runs queries on the user's
 * engine session, so we never fan them out unasked) — except while a filter is
 * active, when every tree is loaded so the search can see the whole lake.
 *
 * Catalogs the user can't open (`accessible === false`, or a tree call that
 * answered 403 access:false) are listed — so they can be asked for — but render
 * locked: muted, no caret, never fetched, and a click shows who to ask instead
 * of pretending the catalog is empty. Accessible catalogs sort first.
 */

export interface TableRef {
  catalog: string;
  schema: string;
  table: string;
}

/** What a right-click in the tree landed on. */
export type TreeTarget =
  | { kind: "catalog"; catalog: string; locked: boolean }
  | { kind: "schema"; catalog: string; schema: string }
  | { kind: "table"; catalog: string; schema: string; table: string };

export function CatalogTree({
  catalogs,
  filter = "",
  selected,
  onPick,
  onDenied,
  onContext,
  refreshToken = 0,
}: {
  catalogs: Catalog[];
  /** Client-side substring filter over catalog / schema / table names. */
  filter?: string;
  selected?: TableRef | null;
  onPick: (ref: TableRef) => void;
  /** Called when the user clicks a catalog they can't open. */
  onDenied?: (info: AccessDenied) => void;
  /** Right-click on a row; omitted → the browser's own menu. */
  onContext?: (target: TreeTarget, x: number, y: number) => void;
  /** Bump to re-fetch every tree already loaded (after a create/rename). */
  refreshToken?: number;
}) {
  const [trees, setTrees] = useState<Record<string, TreeResponse | null>>({});
  const [openCatalogs, setOpen] = useState<string[]>([]);
  const [openSchemas, setOpenSchemas] = useState<string[]>([]);
  /** Catalogs whose tree call answered 403 access:false → the server's owner. */
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  /** The locked catalog whose "No access" note is showing. */
  const [note, setNote] = useState<string | null>(null);

  const locked = (c: Catalog) => c.accessible === false || c.name in blocked;
  const ownerOf = (c: Catalog) => blocked[c.name] || c.owner;

  // Accessible first; Array.prototype.sort is stable, so each half keeps the
  // server's order.
  const sorted = useMemo(
    () =>
      [...catalogs].sort(
        (a, b) =>
          Number(a.accessible === false || a.name in blocked) -
          Number(b.accessible === false || b.name in blocked),
      ),
    [catalogs, blocked],
  );

  const q = filter.trim().toLowerCase();
  const filtering = q.length > 0;

  const treesRef = useRef(trees);
  treesRef.current = trees;

  const fetchTree = (name: string) =>
    api
      .get<TreeResponse>(`/catalogs/${encodeURIComponent(name)}/tree`)
      .then((t) => setTrees((cur) => ({ ...cur, [name]: t })))
      .catch((e) => {
        const denied = accessDenied(e, name);
        if (denied) setBlocked((cur) => ({ ...cur, [name]: denied.owner }));
        setTrees((cur) => ({ ...cur, [name]: { schemas: [] } }));
      });

  const load = (name: string) => {
    setTrees((cur) => (name in cur ? cur : { ...cur, [name]: null }));
    fetchTree(name);
  };

  // Re-read what is already on screen; the old tree stays up until the new
  // one lands so nothing flickers to "Loading…".
  useEffect(() => {
    if (!refreshToken) return;
    for (const name of Object.keys(treesRef.current)) fetchTree(name);
  }, [refreshToken]);

  const ctx = (target: TreeTarget) =>
    onContext
      ? (e: MouseEvent) => {
          e.preventDefault();
          onContext(target, e.clientX, e.clientY);
        }
      : undefined;

  // Open the first catalog on arrival so the panel is never a dead end.
  useEffect(() => {
    const first = catalogs.find((c) => c.accessible !== false);
    if (!first) return;
    setOpen((cur) => (cur.length ? cur : [first.name]));
  }, [catalogs]);

  // A selection made from outside the tree (a ?table= deep link from search
  // or Recents) reveals its branch, so the highlighted row is actually visible.
  const selCatalog = selected?.catalog;
  const selSchema = selected?.schema;
  useEffect(() => {
    if (!selCatalog || !selSchema) return;
    const key = `${selCatalog}.${selSchema}`;
    setOpen((cur) => (cur.includes(selCatalog) ? cur : [...cur, selCatalog]));
    setOpenSchemas((cur) => (cur.includes(key) ? cur : [...cur, key]));
  }, [selCatalog, selSchema]);

  // Load whatever is open, plus everything while searching.
  useEffect(() => {
    const unlocked = new Set(catalogs.filter((c) => c.accessible !== false).map((c) => c.name));
    const wanted = filtering ? [...unlocked] : openCatalogs;
    for (const name of wanted) {
      if (unlocked.has(name) && !(name in trees)) load(name);
    }
    // `trees` is intentionally read, not depended on: load() guards re-entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCatalogs, filtering, catalogs]);

  const toggleCatalog = (c: Catalog) => {
    if (locked(c)) {
      const owner = ownerOf(c);
      setNote((cur) => (cur === c.name ? null : c.name));
      onDenied?.({
        catalog: c.name,
        owner,
        message: `You don't have access to ${c.name}. Ask its owner (${owner || "unknown"}) or an admin to grant one of your groups.`,
      });
      return;
    }
    const name = c.name;
    setOpen((cur) => (cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name]));
    if (!(name in trees)) load(name);
  };
  const toggleSchema = (key: string) =>
    setOpenSchemas((cur) => (cur.includes(key) ? cur.filter((n) => n !== key) : [...cur, key]));

  const matchingSchemas = (catalog: string, schemas: SchemaNode[]) =>
    schemas
      .map((s) => ({
        ...s,
        tables: filtering
          ? s.tables.filter(
              (t) =>
                t.toLowerCase().includes(q) ||
                s.name.toLowerCase().includes(q) ||
                catalog.toLowerCase().includes(q),
            )
          : s.tables,
      }))
      .filter((s) => !filtering || s.tables.length > 0 || s.name.toLowerCase().includes(q));

  const visibleCatalogs = filtering
    ? sorted.filter((c) => {
        if (c.name.toLowerCase().includes(q)) return true;
        if (locked(c)) return false;
        const tree = trees[c.name];
        return tree ? matchingSchemas(c.name, tree.schemas).length > 0 : true;
      })
    : sorted;

  if (filtering && visibleCatalogs.length === 0) {
    return <div style={hint}>Nothing matches “{filter.trim()}”.</div>;
  }

  return (
    <div style={{ padding: "6px 6px 14px" }}>
      {visibleCatalogs.map((c) => {
        if (locked(c)) {
          const owner = ownerOf(c);
          return (
            <div key={c.name}>
              <TreeRow
                depth={0}
                muted
                onClick={() => toggleCatalog(c)}
                onContextMenu={ctx({ kind: "catalog", catalog: c.name, locked: true })}
                glyph={<LockGlyph />}
                label={c.name}
                weight={600}
                title={`No access to ${c.name}`}
              />
              {note === c.name && (
                <div style={{ ...hint, paddingLeft: 30 }}>
                  No access — ask {owner || "its owner"} or an admin
                </div>
              )}
            </div>
          );
        }
        const open = filtering || openCatalogs.includes(c.name);
        const tree = trees[c.name];
        const schemas = tree ? matchingSchemas(c.name, tree.schemas) : [];
        return (
          <div key={c.name}>
            <TreeRow
              depth={0}
              open={open}
              caret
              onClick={() => toggleCatalog(c)}
              onContextMenu={ctx({ kind: "catalog", catalog: c.name, locked: false })}
              glyph={<DbGlyph />}
              label={c.name}
              weight={600}
            />
            {open && !tree && <div style={{ ...hint, paddingLeft: 30 }}>Loading…</div>}
            {open && tree && schemas.length === 0 && (
              <div style={{ ...hint, paddingLeft: 30 }}>No schemas yet.</div>
            )}
            {open &&
              schemas.map((s) => {
                const key = `${c.name}.${s.name}`;
                const sOpen = filtering || openSchemas.includes(key);
                return (
                  <div key={key}>
                    <TreeRow
                      depth={1}
                      open={sOpen}
                      caret
                      onClick={() => toggleSchema(key)}
                      onContextMenu={ctx({ kind: "schema", catalog: c.name, schema: s.name })}
                      glyph={<span style={{ color: "var(--text-faint)" }}>▤</span>}
                      label={s.name}
                    />
                    {sOpen && s.tables.length === 0 && (
                      <div style={{ ...hint, paddingLeft: 46 }}>An empty schema is valid</div>
                    )}
                    {sOpen &&
                      s.tables.map((t) => {
                        const on =
                          selected?.catalog === c.name &&
                          selected?.schema === s.name &&
                          selected?.table === t;
                        return (
                          <TreeRow
                            key={t}
                            depth={2}
                            active={on}
                            onClick={() => onPick({ catalog: c.name, schema: s.name, table: t })}
                            onContextMenu={ctx({
                              kind: "table",
                              catalog: c.name,
                              schema: s.name,
                              table: t,
                            })}
                            glyph={
                              <span style={{ color: on ? "var(--accent)" : "var(--text-faint)" }}>
                                ▦
                              </span>
                            }
                            label={t}
                          />
                        );
                      })}
                  </div>
                );
              })}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The workbench context panel wrapper shared by the SQL editor and the
 * notebook: the same three states in the same order, so a 503 never reads as
 * "No catalogs yet" on one screen and "Loading…" forever on the other.
 */
export function CatalogPanel({
  catalogs,
  error,
  onPick,
}: {
  catalogs: Catalog[] | null;
  error?: string;
  onPick: (ref: TableRef) => void;
}) {
  return (
    <>
      <div style={{ padding: "8px 12px", fontSize: "var(--fs-label)", color: "var(--text-dim)" }}>
        Click a table to insert its name
      </div>
      {error ? (
        <div style={{ padding: "8px 12px", fontSize: "var(--fs-small)", color: "var(--err)" }}>{error}</div>
      ) : catalogs === null ? (
        <div style={hint}>Loading catalogs…</div>
      ) : catalogs.length === 0 ? (
        <div style={hint}>No catalogs yet — create one from the Catalog screen.</div>
      ) : (
        <CatalogTree catalogs={catalogs} onPick={onPick} />
      )}
    </>
  );
}

function TreeRow({
  depth,
  label,
  glyph,
  caret,
  open,
  active,
  weight,
  muted,
  title,
  onClick,
  onContextMenu,
}: {
  depth: number;
  label: string;
  glyph?: React.ReactNode;
  caret?: boolean;
  open?: boolean;
  active?: boolean;
  weight?: number;
  /** Locked catalog: faint text, no hover emphasis beyond the background. */
  muted?: boolean;
  title?: string;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        width: "100%",
        textAlign: "left",
        border: "none",
        borderRadius: 8,
        padding: "5px 8px",
        paddingLeft: 8 + depth * 14,
        fontSize: "var(--fs-body)",
        fontWeight: weight ?? (active ? 600 : 400),
        fontFamily: "inherit",
        background: active ? "var(--accent-tint)" : hover ? "var(--hover)" : "transparent",
        color: active ? "var(--accent-tint-ink)" : muted ? "var(--text-faint)" : "var(--text-mid)",
      }}
    >
      <span
        style={{
          width: 9,
          flexShrink: 0,
          fontSize: "var(--fs-2xs)",
          color: "var(--text-faint)",
          visibility: caret ? "visible" : "hidden",
        }}
      >
        {open ? "▾" : "▸"}
      </span>
      {glyph && <span style={{ flexShrink: 0, fontSize: "var(--fs-label)" }}>{glyph}</span>}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
    </button>
  );
}

/** 13px database cylinder, matching the rail's catalog icon. */
function DbGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      style={{ color: "var(--text-faint)", display: "block" }}
    >
      <path d="M13 3.9c0 1-2.2 1.8-5 1.8s-5-.8-5-1.8S5.2 2.1 8 2.1s5 .8 5 1.8Z" />
      <path d="M3 3.9v8.2c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V3.9" />
    </svg>
  );
}

/** 13px padlock for catalogs the user can't open. */
function LockGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-label="No access"
      style={{ color: "var(--text-faint)", display: "block" }}
    >
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

const hint: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: "var(--fs-label)",
  color: "var(--text-dim)",
};
