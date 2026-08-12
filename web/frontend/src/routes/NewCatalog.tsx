import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, type User } from "../api";
import type { Catalog as CatalogRow, Group } from "../catalogs";

/*
 * /newcatalog — Create catalog (spec §5 "newcatalog").
 *
 * The form and the SQL are the same operation (REQ-25): the dark card on the
 * right is not decoration, it is what the button runs, rendered live.
 */

const SCHEMAS = ["bronze", "silver", "gold"];
/** pebblesd's catalog-name rule (crates/pebblesd/src/catalog.rs::valid_name). */
const VALID = /^[a-z][a-z0-9_]{0,30}$/;

export function NewCatalog({ user }: { user: User }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [schemas, setSchemas] = useState<string[]>(["bronze", "silver", "gold"]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [grants, setGrants] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .get<Group[]>("/groups")
      .then(setGroups)
      .catch(() => setGroups([]));
  }, []);

  const valid = VALID.test(name);
  const storage = `/var/lib/pebbles/lake/${name || "<name>"}`;

  const sql = useMemo(() => {
    const n = name || "<name>";
    const lines = [`CREATE CATALOG ${n};`];
    for (const s of schemas) lines.push(`CREATE SCHEMA ${n}.${s};`);
    for (const g of grants) lines.push(`GRANT ALL ON CATALOG ${n} TO '${g}';`);
    return lines.join("\n");
  }, [name, schemas, grants]);

  const toggle = (list: string[], set: (v: string[]) => void, value: string) =>
    set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const create = () => {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    api
      .post<CatalogRow>("/catalogs", { name })
      .then(async () => {
        for (const g of grants) {
          await api.post(`/catalogs/${encodeURIComponent(name)}/grants`, { group: g });
        }
        navigate("/catalog");
      })
      .catch((e) => {
        setError(String(e.message ?? e));
        setBusy(false);
      });
  };

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "34px 40px 60px" }}>
      <div className="mono" style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 8 }}>
        <button type="button" onClick={() => navigate("/catalog")} style={crumbBtn}>
          ‹ Catalog
        </button>
      </div>
      <h1 style={{ fontSize: 25, fontWeight: 600, letterSpacing: "-0.5px", marginBottom: 22 }}>
        Create catalog
      </h1>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          gap: 20,
          alignItems: "start",
        }}
      >
        {/* ---- left: the form ------------------------------------------- */}
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 14,
            padding: 20,
            display: "grid",
            gap: 16,
          }}
        >
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="phd_lake"
              autoFocus
              className="mono"
              style={{
                width: "100%",
                padding: "11px 13px",
                border: `1px solid ${name && !valid ? "var(--err)" : "var(--accent)"}`,
                borderRadius: 12,
                background: "var(--surface)",
                fontSize: 14,
                color: "var(--text)",
                outline: "none",
              }}
            />
            <div
              style={{
                fontSize: 11,
                color: name && !valid ? "var(--err)" : "var(--text-dim)",
                marginTop: 6,
              }}
            >
              Lowercase letter first, then letters, digits, or underscores — up to 31 characters.
            </div>
          </Field>

          <Field label="Owner">
            <ReadOnly mono>{user.username}</ReadOnly>
          </Field>

          <Field label="Storage root">
            <ReadOnly mono>{storage}</ReadOnly>
          </Field>

          <Field label="Table format">
            <ReadOnly>DuckLake · Parquet</ReadOnly>
          </Field>

          <Field label="Schemas">
            <div style={{ display: "grid", gap: 6 }}>
              {SCHEMAS.map((s) => (
                <Check
                  key={s}
                  checked={schemas.includes(s)}
                  onChange={() => toggle(schemas, setSchemas, s)}
                  label={s}
                />
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 6 }}>
              An empty schema is valid — these just seed the medallion layout.
            </div>
          </Field>

          <Field label="Access grants">
            {groups.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--text-dim)" }}>
                No groups yet. Grants target UNIX groups — create one under Groups first.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {groups.map((g) => (
                  <Check
                    key={g.name}
                    checked={grants.includes(g.name)}
                    onChange={() => toggle(grants, setGrants, g.name)}
                    label={g.name}
                    hint={`gid ${g.gid} · ${g.members.length} member${
                      g.members.length === 1 ? "" : "s"
                    }`}
                  />
                ))}
              </div>
            )}
          </Field>

          {error && <div style={{ color: "var(--err)", fontSize: 12.5 }}>{error}</div>}

          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="button"
              onClick={create}
              disabled={!valid || busy}
              style={{
                background: valid && !busy ? "var(--accent)" : "var(--track)",
                color: valid && !busy ? "var(--on-accent)" : "var(--text-dim)",
                border: "none",
                borderRadius: 11,
                fontWeight: 600,
                fontSize: 13,
                padding: "9px 18px",
                cursor: valid && !busy ? "pointer" : "not-allowed",
              }}
            >
              {busy ? "Creating…" : "Create catalog"}
            </button>
            <button type="button" onClick={() => navigate("/catalog")} style={ghost}>
              Cancel
            </button>
          </div>
        </div>

        {/* ---- right: the equivalent SQL --------------------------------- */}
        <div
          style={{
            background: "var(--deep)",
            border: "1px solid var(--deep-border)",
            borderRadius: 14,
            overflow: "hidden",
            position: "sticky",
            top: 20,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              padding: "12px 16px",
              borderBottom: "1px solid var(--deep-border)",
            }}
          >
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: "0.8px",
                textTransform: "uppercase",
                color: "var(--deep-faint)",
              }}
            >
              Equivalent SQL
            </span>
            <button
              type="button"
              onClick={() => navigate(`/sql?q=${encodeURIComponent(sql)}`)}
              style={{
                background: "transparent",
                border: "1px solid var(--deep-border)",
                borderRadius: 11,
                color: "var(--deep-text-2)",
                fontSize: 11.5,
                padding: "6px 12px",
              }}
            >
              Open in SQL editor
            </button>
          </div>
          <pre
            className="mono"
            style={{
              margin: 0,
              padding: "16px 18px",
              fontSize: 12.5,
              lineHeight: 1.8,
              color: "var(--deep-text)",
              whiteSpace: "pre-wrap",
              overflowWrap: "break-word",
            }}
          >
            {colorize(sql)}
          </pre>
        </div>
      </div>
    </div>
  );
}

/** Keyword/string colouring for the dark card (spec §5 newcatalog). */
function colorize(sql: string): ReactNode[] {
  const re = /(\b(?:CREATE|CATALOG|SCHEMA|GRANT|ALL|ON|TO)\b)|('[^']*')/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(sql)) !== null) {
    if (m.index > last) out.push(sql.slice(last, m.index));
    out.push(
      <span key={key++} style={{ color: m[1] ? "var(--accent)" : "var(--code-str)" }}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < sql.length) out.push(sql.slice(last));
  return out;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          letterSpacing: "0.8px",
          textTransform: "uppercase",
          color: "var(--text-faint)",
          marginBottom: 7,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function ReadOnly({ children, mono }: { children: ReactNode; mono?: boolean }) {
  return (
    <div
      className={mono ? "mono" : undefined}
      style={{
        padding: "10px 12px",
        border: "1px solid var(--border)",
        borderRadius: 11,
        background: "var(--surface-alt)",
        color: "var(--text-mid)",
        fontSize: 13,
        overflowWrap: "break-word",
      }}
    >
      {children}
    </div>
  );
}

function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 13, cursor: "pointer" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        style={{ accentColor: "var(--accent)", width: 15, height: 15 }}
      />
      <span className="mono" style={{ fontSize: 12.5 }}>
        {label}
      </span>
      {hint && <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{hint}</span>}
    </label>
  );
}

const ghost: CSSProperties = {
  background: "var(--surface)",
  color: "var(--text-mid)",
  border: "1px solid var(--border)",
  borderRadius: 11,
  fontSize: 12.5,
  padding: "9px 16px",
};

const crumbBtn: CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  fontSize: 11.5,
  color: "var(--text-dim)",
};
