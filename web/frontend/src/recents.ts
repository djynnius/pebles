// Recents (Home) and global search (Topbar): the wire shapes, the one
// fire-and-forget recorder every screen calls on open, and the route each kind
// of item opens at. Kept together so Home and the search dropdown agree on
// where a "table" or a "query" goes.
import { api } from "./api";

export type RecentKind = "notebook" | "dashboard" | "query" | "table" | "job";
export type SearchKind = "notebook" | "dashboard" | "job" | "catalog" | "table";

export interface Recent {
  kind: RecentKind;
  name: string;
  catalog?: string | null;
  /** ISO timestamp (or epoch seconds) of the last open. */
  at: string | number;
}

export interface SearchHit {
  kind: SearchKind;
  name: string;
  catalog?: string | null;
  schema?: string | null;
}

/** One glyph per kind, matching the sidebar's section glyphs (nav.ts). */
export const KIND_GLYPH: Record<RecentKind | SearchKind, string> = {
  notebook: "▧",
  dashboard: "▦",
  query: "›_",
  table: "▤",
  job: "⇄",
  catalog: "◨",
};

export const KIND_LABEL: Record<RecentKind | SearchKind, string> = {
  notebook: "Notebooks",
  dashboard: "Dashboards",
  query: "Queries",
  table: "Tables",
  job: "Jobs",
  catalog: "Catalogs",
};

// Guards against React StrictMode's double effect and polling reloads: the
// same item is recorded at most once in a short window.
let last = { key: "", t: 0 };

/**
 * Record that the user opened something. Fire-and-forget: a failure here must
 * never disturb the screen that is opening, so errors are swallowed.
 */
export function recordRecent(kind: RecentKind, name: string, catalog?: string | null): void {
  if (!name) return;
  const key = `${kind}\u0000${catalog ?? ""}\u0000${name}`;
  const now = Date.now();
  if (key === last.key && now - last.t < 5000) return;
  last = { key, t: now };
  const body: { kind: RecentKind; name: string; catalog?: string } = { kind, name };
  if (catalog) body.catalog = catalog;
  api.post("/recents", body).catch(() => {});
}

const enc = encodeURIComponent;

/** The `?table=` value Catalog.tsx understands: `catalog.schema.table`. */
function tableParam(catalog: string | null | undefined, qualified: string): string {
  return catalog ? `/catalog?table=${enc(`${catalog}.${qualified}`)}` : "/catalog";
}

/** Where a Recents row opens. */
export function recentPath(r: Recent): string {
  switch (r.kind) {
    case "notebook":
      return `/notebooks/${enc(r.name)}`;
    case "dashboard":
      return `/dashboards/${enc(r.name)}`;
    case "job":
      return `/jobs?open=${enc(r.name)}`;
    case "query":
      return r.catalog ? `/sql?catalog=${enc(r.catalog)}` : "/sql";
    case "table":
      // Recorded as name "schema.table" plus catalog.
      return tableParam(r.catalog, r.name);
  }
}

/** Where a search hit opens. */
export function hitPath(h: SearchHit): string {
  switch (h.kind) {
    case "notebook":
      return `/notebooks/${enc(h.name)}`;
    case "dashboard":
      return `/dashboards/${enc(h.name)}`;
    case "job":
      return `/jobs?open=${enc(h.name)}`;
    case "catalog":
      return "/catalog";
    case "table":
      return h.schema ? tableParam(h.catalog, `${h.schema}.${h.name}`) : "/catalog";
  }
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", else a short date. */
export function relativeTime(at: string | number, now = Date.now()): string {
  const t = typeof at === "number" ? (at < 1e12 ? at * 1000 : at) : Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
