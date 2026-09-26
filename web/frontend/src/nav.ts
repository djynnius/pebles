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
