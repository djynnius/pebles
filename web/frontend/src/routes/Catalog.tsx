import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, columnsOf, errorText, type Row, type User } from "../api";
import {
  accessDenied,
  qualify,
  useCatalogs,
  type AccessDenied,
  type Engine,
  type Grant,
  type Group,
  type TableDetail,
} from "../catalogs";
import { CatalogTree, type TableRef } from "../components/CatalogTree";
import { StatusDot } from "../components/Table";
import { Empty, EmptyAction, ErrorBlock, Loading } from "../components/State";

/*
 * /catalog — the lake browser (spec §5 "catalog").
 *
 * Its own two-column layout (290px tree + document column), deliberately NOT
 * the 266px workbench panel: the tree is the screen here, not a side channel.
 */

type TabId = "schema" | "sample" | "snapshots" | "lineage" | "permissions";
const TABS: { id: TabId; label: string }[] = [
  { id: "schema", label: "Schema" },
  { id: "sample", label: "Sample" },
  { id: "snapshots", label: "Snapshots" },
  { id: "lineage", label: "Lineage" },
  { id: "permissions", label: "Permissions" },
];

export function Catalog({ user }: { user: User }) {
  const navigate = useNavigate();
  const { catalogs, error } = useCatalogs();
  const [engine, setEngine] = useState<Engine | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<TableRef | null>(null);
  const [detail, setDetail] = useState<TableDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  /** A catalog the user can't open — shown as a "No access" state, not an error. */
  const [denied, setDenied] = useState<AccessDenied | null>(null);
  const [tab, setTab] = useState<TabId>("schema");

  useEffect(() => {
    api
      .get<Engine[]>("/engines")
      .then((list) => setEngine(list[0] ?? null))
      .catch(() => setEngine(null));
  }, []);

  useEffect(() => {
    if (!selected) return;
    const { catalog, schema, table } = selected;
    setDetail(null);
    setDetailError("");
    api
      .get<TableDetail>(
        `/catalogs/${encodeURIComponent(catalog)}/tables/${encodeURIComponent(
          schema,
        )}/${encodeURIComponent(table)}`,
      )
      .then(setDetail)
      .catch((e) => {
        const d = accessDenied(e, catalog);
        if (d) {
          setDenied(d);
          setSelected(null);
        } else {
          setDetailError(errorText(e));
        }
      });
  }, [selected]);

  const catalogRow = catalogs?.find((c) => c.name === selected?.catalog) ?? null;

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, background: "var(--surface-alt)" }}>
      {/* ---- 290px tree column ------------------------------------------- */}
      <aside
        style={{
          width: 290,
          flex: "0 0 290px",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background: "var(--surface)",
          borderRight: "1px solid var(--border)",
        }}
      >
        <div style={{ padding: "12px 12px 10px", borderBottom: "1px solid var(--border-soft)" }}>
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: 12,
              background: "var(--surface-alt)",
              padding: "10px 12px",
              marginBottom: 10,
            }}
          >
            <div style={eyebrow}>Attached engine</div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 5 }}>
              <StatusDot tone={engine ? "ok" : "dim"} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{engine?.name ?? "No engine"}</span>
            </div>
            <div
              className="mono"
              style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 3 }}
            >
              {engine ? `${engine.state} · ${engine.sessions} session(s)` : "register one first"}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              height: 32,
              padding: "0 10px",
              borderRadius: 11,
              background: "var(--surface-alt)",
              border: "1px solid var(--border)",
            }}
          >
            <span style={{ color: "var(--text-faint)", fontSize: 12 }}>⌕</span>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search tables…"
              style={{
                flex: 1,
                minWidth: 0,
                border: "none",
                background: "transparent",
                color: "var(--text)",
                fontSize: 12.5,
                outline: "none",
              }}
            />
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {catalogs && catalogs.length > 0 && (
            <CatalogTree
              catalogs={catalogs}
              filter={filter}
              selected={selected}
              onPick={(ref) => {
                setDenied(null);
                setSelected(ref);
                setTab("schema");
              }}
              onDenied={(d) => {
                setSelected(null);
                setDenied(d);
              }}
            />
          )}
          {(error || catalogs === null || catalogs.length === 0) && (
            <div style={{ padding: "14px 12px", fontSize: 11.5, color: "var(--text-dim)" }}>
              {error ? "Catalogs unavailable." : catalogs === null ? "Loading catalogs…" : "No catalogs yet."}
            </div>
          )}
        </div>
      </aside>

      {/* ---- document column --------------------------------------------- */}
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto" }}>
        <div style={{ padding: "26px 32px 60px" }}>
          {/* Order matters: error, then in-flight, then empty, then content.
              Reading it the other way used to flash "Pick a table" while the
              list loaded and then swap to "Your lake is empty" — a jump, and
              an invitation to create a catalog even when the lake was simply
              unreadable. */}
          {error ? (
            <ErrorBlock title="Couldn't reach your lake" error={error} />
          ) : catalogs === null ? (
            <Loading label="Loading catalogs…" />
          ) : catalogs.length === 0 ? (
            <EmptyLake onCreate={() => navigate("/newcatalog")} />
          ) : denied ? (
            <NoAccess denied={denied} />
          ) : !selected ? (
            <PickATable />
          ) : (
            <>
              <Breadcrumb parts={[selected.catalog, selected.schema, selected.table]} />

              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 16,
                  flexWrap: "wrap",
                  marginBottom: 20,
                }}
              >
                <div style={{ flex: 1, minWidth: 260 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <h1 style={{ fontSize: 25, fontWeight: 600, letterSpacing: "-0.5px" }}>
                      {selected.table}
                    </h1>
                    {/* The prototype's CERTIFIED pill was sample data: nothing
                        in the API grades a table, and stamping every table
                        "certified" is worse than stamping none. */}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 4 }}
                  >
                    {qualify(selected.catalog, selected.schema, selected.table)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Ghost onClick={() => setTab("permissions")}>Permissions</Ghost>
                  <Ghost onClick={() => setTab("lineage")}>Lineage</Ghost>
                  <Ghost onClick={() => navigate("/newcatalog")}>New catalog</Ghost>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        `/sql?catalog=${encodeURIComponent(selected.catalog)}&q=${encodeURIComponent(
                          `SELECT *\nFROM ${qualify(selected.catalog, selected.schema, selected.table)}\nLIMIT 100;`,
                        )}`,
                      )
                    }
                    style={{
                      background: "var(--accent)",
                      color: "var(--on-accent)",
                      border: "none",
                      borderRadius: 11,
                      fontWeight: 600,
                      fontSize: 12.5,
                      padding: "8px 16px",
                    }}
                  >
                    Query
                  </button>
                </div>
              </div>

              {/* 5 stat tiles */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(5, minmax(0,1fr))",
                  gap: 12,
                  marginBottom: 22,
                }}
              >
                <Stat label="Rows" value={detail?.row_count?.toLocaleString() ?? "—"} />
                {/* This tile shows the catalog's data path — it was labelled
                    "Size", which read as a byte count that never arrives. */}
                <Stat
                  label="Data path"
                  value={catalogRow?.data_path ?? "—"}
                  mono
                  title={catalogRow?.data_path}
                />
                <Stat label="Format" value="Parquet · DuckLake" small />
                <Stat
                  label="Snapshot"
                  value={
                    detail?.snapshots?.length
                      ? String(detail.snapshots[0].snapshot_id ?? "—")
                      : "—"
                  }
                  mono
                />
                <Stat label="Owner" value={catalogRow?.owner ?? "—"} small />
              </div>

              {/* in-page tabs */}
              <div
                style={{
                  display: "flex",
                  gap: 20,
                  borderBottom: "1px solid var(--border)",
                  marginBottom: 18,
                }}
              >
                {TABS.map((t) => {
                  const on = t.id === tab;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTab(t.id)}
                      style={{
                        border: "none",
                        background: "transparent",
                        padding: "0 2px 10px",
                        fontSize: 13,
                        fontFamily: "inherit",
                        fontWeight: on ? 600 : 400,
                        color: on ? "var(--text)" : "var(--text-muted)",
                        borderBottom: on ? "2px solid var(--accent)" : "2px solid transparent",
                      }}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>

              {detailError && (
                <ErrorBlock title={`Couldn't read ${selected.table}`} error={detailError} />
              )}
              {!detail && !detailError && <Loading label="Loading table…" />}

              {detail && tab === "schema" && <SchemaTab detail={detail} />}
              {detail && tab === "sample" && <SampleTab rows={detail.sample} />}
              {detail && tab === "snapshots" && (
                <SnapshotsTab
                  detail={detail}
                  onTravel={(id) =>
                    navigate(
                      `/sql?catalog=${encodeURIComponent(selected.catalog)}&q=${encodeURIComponent(
                        `SELECT *\nFROM ${qualify(
                          selected.catalog,
                          selected.schema,
                          selected.table,
                        )} AT (VERSION => ${id})\nLIMIT 100;`,
                      )}`,
                    )
                  }
                />
              )}
              {tab === "lineage" && <LineageTab />}
              {tab === "permissions" && (
                <PermissionsTab
                  catalog={selected.catalog}
                  canGrant={user.admin === true || catalogRow?.owner === user.username}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- tabs ------------------------------------------------------------- */

function SchemaTab({ detail }: { detail: TableDetail }) {
  if (detail.columns.length === 0) {
    return <Muted>No columns visible — the table may be empty or not yet granted to you.</Muted>;
  }
  return (
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
            {["Column", "Type", "Nulls", "Comment"].map((h) => (
              <th key={h} style={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {detail.columns.map((c) => (
            <tr key={c.column_name}>
              <td className="mono" style={{ ...td, fontSize: 12.5 }}>
                {c.column_name}
              </td>
              <td className="mono" style={{ ...td, fontSize: 12.5, color: "var(--viz-5)" }}>
                {c.data_type}
              </td>
              <td style={td}>
                {String(c.is_nullable).toUpperCase() === "YES" ? (
                  <span style={{ color: "var(--text-dim)" }}>nullable</span>
                ) : (
                  <span style={{ color: "var(--ok-ink)" }}>not null</span>
                )}
              </td>
              <td style={{ ...td, color: "var(--text-dim)" }}>—</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SampleTab({ rows }: { rows: Row[] }) {
  if (!rows || rows.length === 0) return <Muted>No sample rows.</Muted>;
  return <ResultGrid rows={rows.slice(0, 25)} />;
}

function SnapshotsTab({
  detail,
  onTravel,
}: {
  detail: TableDetail;
  onTravel: (id: string) => void;
}) {
  if (!detail.snapshots || detail.snapshots.length === 0) {
    return <Muted>No snapshots recorded for this catalog yet.</Muted>;
  }
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        overflow: "hidden",
      }}
    >
      {detail.snapshots.map((s, i) => {
        const id = String(s.snapshot_id ?? i);
        const when = s.snapshot_time ?? s.created_at ?? s.timestamp;
        return (
          <div
            key={id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "12px 16px",
              borderBottom:
                i === detail.snapshots.length - 1 ? "none" : "1px solid var(--border-soft)",
            }}
          >
            <span
              className="mono"
              style={{ fontSize: 12.5, fontWeight: 600, minWidth: 70 }}
            >
              #{id}
            </span>
            <span className="mono" style={{ flex: 1, fontSize: 11.5, color: "var(--text-dim)" }}>
              {when ? String(when) : "—"}
            </span>
            {i === 0 && (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: 20,
                  background: "var(--ok-tint)",
                  color: "var(--ok-ink)",
                  fontSize: 10.5,
                  fontWeight: 600,
                }}
              >
                LATEST
              </span>
            )}
            <button
              type="button"
              onClick={() => onTravel(id)}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--accent-ink)",
                fontSize: 12.5,
                fontFamily: "inherit",
              }}
            >
              Time travel →
            </button>
          </div>
        );
      })}
    </div>
  );
}

function LineageTab() {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        padding: "44px 30px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 22, marginBottom: 8, color: "var(--text-faint)" }}>⌥</div>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Lineage arrives with Auto ETL</div>
      <div style={{ fontSize: 12.5, color: "var(--text-dim)", maxWidth: 420, margin: "0 auto" }}>
        Once pipelines write through Pebbles, this tab draws the graph of what produced this table
        and what reads from it.
      </div>
    </div>
  );
}

function PermissionsTab({ catalog, canGrant }: { catalog: string; canGrant: boolean }) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reload = () =>
    api
      .get<Grant[]>(`/catalogs/${encodeURIComponent(catalog)}/grants`)
      .then(setGrants)
      // Leave `grants` null on failure so "only the owner can read this" is
      // never shown as if it were the answer.
      .catch((e) => setError(errorText(e)));

  useEffect(() => {
    setGrants(null);
    setError("");
    reload();
    if (canGrant) {
      api
        .get<Group[]>("/groups")
        .then(setGroups)
        .catch(() => setGroups([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, canGrant]);

  const add = () => {
    if (!choice) return;
    setBusy(true);
    setError("");
    api
      .post(`/catalogs/${encodeURIComponent(catalog)}/grants`, { group: choice })
      .then(() => {
        setChoice("");
        return reload();
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  const ungranted = groups.filter((g) => !grants?.some((x) => x.group === g.name));

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {error && <ErrorBlock error={error} style={{ marginBottom: 0 }} />}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border-soft)",
            fontWeight: 600,
            fontSize: 13.5,
          }}
        >
          Groups with access to {catalog}
        </div>
        {grants === null && !error && <div style={{ padding: 16, ...muted }}>Loading…</div>}
        {grants === null && error && (
          <div style={{ padding: 16, ...muted }}>Grants unavailable — see the message above.</div>
        )}
        {grants?.length === 0 && (
          <div style={{ padding: 16, ...muted }}>
            Only the owner can read this catalog. Grants target UNIX groups — there is no second
            permission system.
          </div>
        )}
        {grants?.map((g) => (
          <div
            key={g.group}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "11px 16px",
              borderTop: "1px solid var(--border-soft)",
            }}
          >
            <span className="mono" style={{ fontSize: 12.5, flex: 1 }}>
              {g.group}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>read · write</span>
          </div>
        ))}
      </div>

      {!canGrant ? (
        <div style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
          Only the catalog&apos;s owner or an admin can grant access.
        </div>
      ) : (
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
        }}
      >
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>Add a group</span>
        {groups.length === 0 && (
          <span style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
            No groups to grant — create one on the main container first.
          </span>
        )}
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          style={{
            padding: "8px 10px",
            border: "1px solid var(--border)",
            borderRadius: 11,
            background: "var(--surface)",
            color: "var(--text)",
            fontSize: 12.5,
          }}
        >
          <option value="">Select a group…</option>
          {ungranted.map((g) => (
            <option key={g.name} value={g.name}>
              {g.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!choice || busy}
          onClick={add}
          style={{
            background: choice ? "var(--accent)" : "var(--track)",
            color: choice ? "var(--on-accent)" : "var(--text-dim)",
            border: "none",
            borderRadius: 11,
            fontWeight: 600,
            fontSize: 12.5,
            padding: "8px 16px",
            cursor: choice ? "pointer" : "not-allowed",
          }}
        >
          {busy ? "Granting…" : "Grant"}
        </button>
      </div>
      )}
    </div>
  );
}

/* ---- shared bits ------------------------------------------------------- */

export function ResultGrid({ rows, columns: given }: { rows: Row[]; columns?: string[] }) {
  // An explicit column list (e.g. a DataFrame's) wins; otherwise SELECT order.
  const columns = useMemo(() => (given && given.length ? given : columnsOf(rows)), [rows, given]);

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 14,
        overflowX: "auto",
      }}
    >
      <table className="mono" style={{ borderCollapse: "collapse", minWidth: "100%" }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} style={{ ...th, whiteSpace: "nowrap" }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td
                  key={c}
                  style={{
                    padding: "9px 16px",
                    borderBottom: "1px solid var(--border-faint)",
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    color: typeof r[c] === "number" ? "var(--code-num)" : "var(--text)",
                  }}
                >
                  {cell(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function cell(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function Stat({
  label,
  value,
  mono,
  small,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
  title?: string;
}) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 14,
        minWidth: 0,
      }}
    >
      <div style={eyebrow}>{label}</div>
      <div
        className={mono ? "mono" : undefined}
        title={title}
        style={{
          fontSize: mono || small ? 13 : 19,
          fontWeight: 600,
          marginTop: 5,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function Breadcrumb({ parts }: { parts: string[] }) {
  return (
    <div
      className="mono"
      style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 10 }}
    >
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <span style={{ margin: "0 6px", color: "var(--text-faint)" }}>›</span>}
          <span style={i === parts.length - 1 ? { color: "var(--text-mid)" } : undefined}>{p}</span>
        </span>
      ))}
    </div>
  );
}

function EmptyLake({ onCreate }: { onCreate: () => void }) {
  return (
    <Empty
      style={{ maxWidth: 460, margin: "80px auto 0" }}
      glyph="◨"
      title="Your lake is empty"
      body="A catalog is a DuckLake namespace — Parquet on your disks, catalogued in Postgres, with time travel from the first write."
      action={<EmptyAction onClick={onCreate}>New catalog</EmptyAction>}
    />
  );
}

function NoAccess({ denied }: { denied: AccessDenied }) {
  return (
    <Empty
      inline
      style={{ maxWidth: 440, margin: "90px auto 0" }}
      glyph="⊘"
      title={`No access to ${denied.catalog}`}
      body={denied.message}
    />
  );
}

function PickATable() {
  return (
    <Empty
      inline
      style={{ maxWidth: 420, margin: "90px auto 0" }}
      glyph="▦"
      title="Pick a table"
      body="Expand a catalog on the left to browse its schemas and tables."
    />
  );
}

function Ghost({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "var(--surface)",
        color: "var(--text-mid)",
        border: "1px solid var(--border)",
        borderRadius: 11,
        fontSize: 12.5,
        padding: "8px 14px",
      }}
    >
      {children}
    </button>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p style={{ ...muted, fontSize: 13 }}>{children}</p>;
}

const muted: CSSProperties = { color: "var(--text-dim)", fontSize: 12.5 };

const eyebrow: CSSProperties = {
  fontSize: 10.5,
  letterSpacing: "0.8px",
  textTransform: "uppercase",
  color: "var(--text-faint)",
  fontWeight: 600,
};

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
