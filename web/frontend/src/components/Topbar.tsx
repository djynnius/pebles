import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTheme } from "../theme";
import { api, errorText, type User } from "../api";
import { KIND_GLYPH, KIND_LABEL, hitPath, type SearchHit, type SearchKind } from "../recents";

export function Topbar({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const { theme, toggle } = useTheme();
  const initials = user.username.slice(0, 2).toUpperCase();
  return (
    <header
      style={{
        height: 52,
        flex: "0 0 52px",
        background: "var(--surface)",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        gap: 16,
        position: "sticky",
        top: 0,
        zIndex: 20,
      }}
    >
      <span
        className="mono"
        style={{
          fontSize: "var(--fs-small)",
          color: "var(--accent-deep)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "3px 9px",
        }}
      >
        pebbles
      </span>

      <GlobalSearch />

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
        <span
          title={`Signed in as ${user.username}`}
          style={{
            width: 29,
            height: 29,
            borderRadius: "50%",
            background: "var(--accent-deep)",
            color: "var(--deep-text)",
            display: "grid",
            placeItems: "center",
            fontSize: "var(--fs-meta)",
            fontWeight: 600,
          }}
        >
          {initials}
        </span>
        <button
          type="button"
          onClick={toggle}
          title={theme === "light" ? "Switch to Night" : "Switch to Daylight"}
          aria-label={theme === "light" ? "Switch to Night theme" : "Switch to Daylight theme"}
          style={iconBtn}
          className="pb-icon-btn"
        >
          {theme === "light" ? "☾" : "☀"}
        </button>
        <button
          type="button"
          onClick={onSignOut}
          title="Sign out"
          aria-label="Sign out"
          style={iconBtn}
          className="pb-icon-btn signout"
        >
          ⏻
        </button>
      </div>
    </header>
  );
}

const iconBtn: React.CSSProperties = {
  width: 29,
  height: 29,
  borderRadius: 11,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text-mid)",
  fontSize: "var(--fs-md)",
};

/* ---- global search (spec §3 topbar) ------------------------------------- */

const SEARCH_DEBOUNCE_MS = 200;
const MIN_QUERY = 2;
/** Group order in the dropdown: things you open first, the lake last. */
const KIND_ORDER: SearchKind[] = ["notebook", "dashboard", "job", "catalog", "table"];
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The secondary mono line under a hit — where it lives, when that helps. */
function hitWhere(h: SearchHit): string {
  if (h.kind === "table") return [h.catalog, h.schema].filter(Boolean).join(".");
  return "";
}

/**
 * Live search over everything the user can open (GET /api/search). Debounced,
 * grouped by kind, fully keyboard-driven: ⌘K / Ctrl+K focuses, ↑/↓ moves,
 * Enter opens, Esc closes. The server already filters to what the user may
 * open, so every row is a working link.
 */
function GlobalSearch() {
  const nav = useNavigate();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);

  const term = q.trim();

  // Debounced fetch; a sequence number drops answers to superseded queries.
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    if (term.length < MIN_QUERY) {
      setHits(null);
      setSearching(false);
      setError("");
      return;
    }
    setSearching(true);
    const t = window.setTimeout(() => {
      api
        .get<SearchHit[]>(`/search?q=${encodeURIComponent(term)}`)
        .then((r) => {
          if (mine !== seq.current) return;
          setHits(r);
          setError("");
          setActive(0);
        })
        .catch((e) => {
          if (mine !== seq.current) return;
          setHits([]);
          setError(errorText(e));
        })
        .finally(() => mine === seq.current && setSearching(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [term]);

  // ⌘K / Ctrl+K from anywhere focuses the field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Dismiss on a press anywhere outside the field and its panel.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Grouped for display, flattened (in the same order) for ↑/↓.
  const groups = useMemo(
    () =>
      KIND_ORDER.map((kind) => ({ kind, items: (hits ?? []).filter((h) => h.kind === kind) })).filter(
        (g) => g.items.length > 0,
      ),
    [hits],
  );
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const go = (h: SearchHit) => {
    setOpen(false);
    setQ("");
    inputRef.current?.blur();
    nav(hitPath(h));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      inputRef.current?.blur();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      if (flat.length) setActive((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setActive((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      const h = flat[active];
      if (h) {
        e.preventDefault();
        go(h);
      }
    }
  };

  const showPanel = open && term.length >= MIN_QUERY;
  const optionId = (i: number) => `${listId}-opt-${i}`;
  let index = -1;

  return (
    <div ref={boxRef} style={{ flex: 1, maxWidth: 560, position: "relative" }}>
      <div
        style={{
          height: 32,
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "var(--surface-alt)",
          border: `1px solid ${open ? "var(--accent)" : "var(--border)"}`,
          borderRadius: 11,
          padding: "0 12px",
          color: "var(--text-faint)",
          fontSize: "var(--fs-base)",
        }}
      >
        <span aria-hidden="true">⌕</span>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search tables, notebooks, jobs…"
          aria-label="Search tables, notebooks, dashboards, jobs and catalogs"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-activedescendant={showPanel && flat[active] ? optionId(active) : undefined}
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            background: "transparent",
            outline: "none",
            color: "var(--text)",
            fontSize: "var(--fs-base)",
          }}
        />
        <span className="mono" aria-hidden="true" style={{ fontSize: "var(--fs-label)" }}>
          {IS_MAC ? "⌘K" : "Ctrl K"}
        </span>
      </div>

      {showPanel && (
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          style={{
            position: "absolute",
            top: 38,
            left: 0,
            right: 0,
            maxHeight: "min(440px, calc(100vh - 80px))",
            overflowY: "auto",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "0 8px 26px rgba(20,22,16,.22)",
            padding: "6px 0",
            zIndex: 30,
          }}
        >
          {error ? (
            <div role="alert" className="mono" style={{ ...panelNote, color: "var(--err)" }}>
              {error}
            </div>
          ) : hits === null || (searching && flat.length === 0) ? (
            <div aria-live="polite" style={panelNote}>
              Searching…
            </div>
          ) : flat.length === 0 ? (
            <div aria-live="polite" style={panelNote}>
              No results for “{term}”.
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.kind} role="group" aria-label={KIND_LABEL[g.kind]}>
                <div
                  style={{
                    fontSize: "var(--fs-eyebrow)",
                    letterSpacing: "0.8px",
                    textTransform: "uppercase",
                    color: "var(--text-faint)",
                    padding: "8px 14px 4px",
                  }}
                >
                  {KIND_LABEL[g.kind]}
                </div>
                {g.items.map((h) => {
                  index += 1;
                  const i = index;
                  const on = i === active;
                  const where = hitWhere(h);
                  return (
                    <div
                      key={`${h.kind}:${h.catalog ?? ""}:${h.schema ?? ""}:${h.name}`}
                      id={optionId(i)}
                      role="option"
                      aria-selected={on}
                      onMouseEnter={() => setActive(i)}
                      // mousedown, not click: keeps focus in the input so the
                      // outside-press handler never races the navigation.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        go(h);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "7px 14px",
                        cursor: "pointer",
                        background: on ? "var(--hover)" : "transparent",
                        color: "var(--text)",
                        fontSize: "var(--fs-base)",
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          width: 18,
                          textAlign: "center",
                          color: on ? "var(--accent)" : "var(--text-faint)",
                          flexShrink: 0,
                        }}
                      >
                        {KIND_GLYPH[h.kind]}
                      </span>
                      <span
                        className="mono"
                        style={{
                          fontSize: "var(--fs-body)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          minWidth: 0,
                        }}
                      >
                        {h.name}
                      </span>
                      {where && (
                        <span
                          className="mono"
                          style={{
                            marginLeft: "auto",
                            fontSize: "var(--fs-label)",
                            color: "var(--text-dim)",
                            flexShrink: 0,
                          }}
                        >
                          {where}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

const panelNote: React.CSSProperties = {
  padding: "10px 14px",
  fontSize: "var(--fs-body)",
  color: "var(--text-dim)",
};
