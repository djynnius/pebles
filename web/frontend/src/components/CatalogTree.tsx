import { useEffect, useState } from "react";
import { api } from "../api";
import type { Catalog, SchemaNode, TreeResponse } from "../catalogs";

/*
 * catalog › schema › table tree, shared by the Catalog browser's 290px column
 * and the SQL editor's 266px context panel. Schemas/tables are fetched lazily
 * per catalog on first expand (each /tree call runs queries on the user's
 * engine session, so we never fan them out unasked) — except while a filter is
 * active, when every tree is loaded so the search can see the whole lake.
 */

export interface TableRef {
  catalog: string;
  schema: string;
  table: string;
}

export function CatalogTree({
  catalogs,
  filter = "",
  selected,
  onPick,
}: {
  catalogs: Catalog[];
  /** Client-side substring filter over catalog / schema / table names. */
  filter?: string;
  selected?: TableRef | null;
  onPick: (ref: TableRef) => void;
}) {
  const [trees, setTrees] = useState<Record<string, TreeResponse | null>>({});
  const [openCatalogs, setOpen] = useState<string[]>([]);
  const [openSchemas, setOpenSchemas] = useState<string[]>([]);

  const q = filter.trim().toLowerCase();
  const filtering = q.length > 0;

  const load = (name: string) => {
    setTrees((cur) => (name in cur ? cur : { ...cur, [name]: null }));
    api
      .get<TreeResponse>(`/catalogs/${encodeURIComponent(name)}/tree`)
      .then((t) => setTrees((cur) => ({ ...cur, [name]: t })))
      .catch(() => setTrees((cur) => ({ ...cur, [name]: { schemas: [] } })));
  };

  // Open the first catalog on arrival so the panel is never a dead end.
  useEffect(() => {
    if (catalogs.length === 0) return;
    setOpen((cur) => (cur.length ? cur : [catalogs[0].name]));
  }, [catalogs]);

  // Load whatever is open, plus everything while searching.
  useEffect(() => {
    const wanted = filtering ? catalogs.map((c) => c.name) : openCatalogs;
    for (const name of wanted) {
      if (!(name in trees)) load(name);
    }
    // `trees` is intentionally read, not depended on: load() guards re-entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCatalogs, filtering, catalogs]);

  const toggleCatalog = (name: string) => {
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
    ? catalogs.filter((c) => {
        if (c.name.toLowerCase().includes(q)) return true;
        const tree = trees[c.name];
        return tree ? matchingSchemas(c.name, tree.schemas).length > 0 : true;
      })
    : catalogs;

  if (filtering && visibleCatalogs.length === 0) {
    return <div style={hint}>Nothing matches “{filter.trim()}”.</div>;
  }

  return (
    <div style={{ padding: "6px 6px 14px" }}>
      {visibleCatalogs.map((c) => {
        const open = filtering || openCatalogs.includes(c.name);
        const tree = trees[c.name];
        const schemas = tree ? matchingSchemas(c.name, tree.schemas) : [];
        return (
          <div key={c.name}>
            <TreeRow
              depth={0}
              open={open}
              caret
              onClick={() => toggleCatalog(c.name)}
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
      <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
        Click a table to insert its name
      </div>
      {error ? (
        <div style={{ padding: "8px 12px", fontSize: 11.5, color: "var(--err)" }}>{error}</div>
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
  onClick,
}: {
  depth: number;
  label: string;
  glyph?: React.ReactNode;
  caret?: boolean;
  open?: boolean;
  active?: boolean;
  weight?: number;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
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
        fontSize: 12.5,
        fontWeight: weight ?? (active ? 600 : 400),
        fontFamily: "inherit",
        background: active ? "var(--accent-tint)" : hover ? "var(--hover)" : "transparent",
        color: active ? "var(--accent-tint-ink)" : "var(--text-mid)",
      }}
    >
      <span
        style={{
          width: 9,
          flexShrink: 0,
          fontSize: 9,
          color: "var(--text-faint)",
          visibility: caret ? "visible" : "hidden",
        }}
      >
        {open ? "▾" : "▸"}
      </span>
      {glyph && <span style={{ flexShrink: 0, fontSize: 11 }}>{glyph}</span>}
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
    </button>
  );
}

/** 11px database cylinder, matching the rail's catalog icon. */
function DbGlyph() {
  return (
    <svg
      width="11"
      height="11"
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

const hint: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 11,
  color: "var(--text-dim)",
};
