// Sidebar navigation (spec §3): grouped nav rows with Unicode glyphs, matching
// the prototype's route ids.
export interface NavItem {
  id: string;
  label: string;
  glyph: string;
  path: string;
}
export interface NavGroup {
  title: string;
  items: NavItem[];
  /** Shown only to members of the UNIX group `admins`. */
  adminOnly?: boolean;
}

export const NAV: NavGroup[] = [
  {
    title: "Workspace",
    items: [
      { id: "home", label: "Home", glyph: "⌂", path: "/" },
      { id: "workspace", label: "Files", glyph: "▤", path: "/files" },
      { id: "catalog", label: "Catalog", glyph: "◨", path: "/catalog" },
      { id: "nkoyo", label: "Nkoyo", glyph: "N", path: "/nkoyo" },
    ],
  },
  {
    title: "Analysis",
    items: [
      { id: "notebook", label: "Notebooks", glyph: "▧", path: "/notebooks" },
      { id: "sql", label: "SQL editor", glyph: "›_", path: "/sql" },
      { id: "dashboards", label: "Dashboards", glyph: "▦", path: "/dashboards" },
    ],
  },
  {
    title: "Data engineering",
    items: [
      { id: "jobs", label: "Jobs", glyph: "⇄", path: "/jobs" },
      { id: "ingest", label: "Ingestion", glyph: "⇥", path: "/ingest" },
      { id: "autoetl", label: "Auto ETL", glyph: "✦", path: "/autoetl" },
    ],
  },
  {
    title: "Infrastructure",
    items: [
      { id: "engines", label: "Engines", glyph: "◍", path: "/engines" },
      { id: "hosts", label: "Hosts", glyph: "▥", path: "/hosts" },
    ],
  },
  {
    title: "Admin",
    adminOnly: true,
    items: [
      { id: "users", label: "Users", glyph: "◔", path: "/users" },
      { id: "groups", label: "Groups", glyph: "◕", path: "/groups" },
      { id: "usage", label: "Usage", glyph: "◑", path: "/usage" },
    ],
  },
];

/** The footer's Account & Settings row — not in NAV, but it can be active. */
export const SETTINGS_ID = "settings";

/**
 * Routes that belong to a nav item without living under its path. Each entry
 * is a path prefix → the nav id that owns it; matched alongside every item's
 * own path so the longest prefix wins (/jobbuilder beats /jobs's sibling "/").
 */
const NAV_ALIASES: { prefix: string; id: string }[] = [
  { prefix: "/notebooks", id: "notebook" },
  { prefix: "/dashboards", id: "dashboards" },
  { prefix: "/jobbuilder", id: "jobs" },
  { prefix: "/newcatalog", id: "catalog" },
  { prefix: "/engineconfig", id: "engines" },
  { prefix: "/settings", id: SETTINGS_ID },
];

/** Does `pathname` sit at or under `prefix` (segment-aware: /jobs ≠ /jobsx)? */
function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/**
 * The nav id whose marker should be lit for `pathname`, by longest-prefix
 * match over every item's path plus the alias table. Home ("/") matches only
 * itself — otherwise it would swallow every unknown route. Returns null when
 * nothing owns the path.
 */
export function activeNavId(pathname: string): string | null {
  if (pathname === "/") return "home";
  const candidates = [
    ...NAV.flatMap((g) => g.items)
      .filter((i) => i.path !== "/")
      .map((i) => ({ prefix: i.path, id: i.id })),
    ...NAV_ALIASES,
  ];
  let best: { prefix: string; id: string } | null = null;
  for (const c of candidates) {
    if (under(pathname, c.prefix) && (!best || c.prefix.length > best.prefix.length)) best = c;
  }
  return best?.id ?? null;
}
