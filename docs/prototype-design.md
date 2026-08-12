# Pebbles — Prototype Design Specification

Extracted verbatim from `ui_ux.html`, an 811 KB self-extracting HTML bundle. The app is a **React + inline-SVG** single-page design prototype (no external d3 at runtime — charts are hand-built SVG/geometry). The bundle stores the app as a JSON-encoded template string; the runtime is a small proprietary templating layer (`DCLogic` / `x-dc` / `sc-camel-*` / `sc-if` / `sc-for` directives) that compiles to React. All visuals are inline-styled with CSS custom properties resolved from two theme blocks.

Product identity: **"Your lake, your engines, your hardware."** A self-hosted data platform (catalog / notebooks / SQL / jobs / engines) with a local AI assistant named **Nkoyo**. Wordmark: `p{b|es` — `p` green `#A6E22E`, `{` and `|` foreground, `b` orange `#FD971F`, `es` accent pink `#F92672`. Version string throughout: `v0.4.1 · self-hosted`.

> Fidelity note: colours and dimensions below are exact (copied from source). The two referenced external scripts (`text/javascript`, `application/javascript`, ~38 KB total) are the React runtime + template compiler — framework, not app content. The entire UI lives in the decoded template.

---

## 1. Color Token System

Two themes selected via `html[data-pb-theme="light"|"dark"]`. `:root` is the **Daylight (light)** default; `[data-pb-theme="dark"]` overrides for **Night (Monokai)**. Page background is also set on `html`/`body` directly: light `#F1F1EF`, dark `#1E1F1C`.

Palette philosophy (from source comments): *"Daylight — Monokai palette on paper. Neutrals derived from #272822 / #75715E, no warm cast."* and *"Night — Monokai, unmodified."*

### Daylight (`:root`, light — DEFAULT)

| Token | Value | | Token | Value |
|---|---|---|---|---|
| `--bg` | `#F1F1EF` | | `--deep` | `#272822` |
| `--surface` | `#FFFFFF` | | `--deep-soft` | `#1E1F1C` |
| `--surface-alt` | `#F8F8F6` | | `--deep-hover` | `#33342C` |
| `--hover` | `#F3F3F0` | | `--deep-border` | `#3E3D32` |
| `--border` | `#E3E3DF` | | `--nav-active-bg` | `#3E3D32` |
| `--border-soft` | `#ECECE8` | | `--nav-hover-bg` | `#33342C` |
| `--border-faint` | `#F4F4F1` | | `--deep-text` | `#F8F8F2` |
| `--border-strong` | `#D2D2CC` | | `--deep-text-2` | `#D7D7CC` |
| `--track` | `#E8E8E4` | | `--deep-muted` | `#A6A392` |
| `--track-off` | `#D2D2CC` | | `--deep-faint` | `#9A9682` |
| `--text` | `#272822` | | `--ok` | `#4C8300` |
| `--text-mid` | `#4B4C44` | | `--ok-tint` | `#EDF7DA` |
| `--text-muted` | `#6B6858` | | `--ok-ink` | `#3F6D00` |
| `--text-faint` | `#767361` | | `--warn` | `#A85E00` |
| `--text-dim` | `#6E6B5B` | | `--warn-tint` | `#FDF0DC` |
| `--accent` | `#F92672` | | `--err` | `#E01463` |
| `--accent-hover` | `#FF4C8D` | | `--grey` | `#B4B2A6` |
| `--accent-ink` | `#E01463` | | `--code-str` | `#4C8300` |
| `--accent-deep` | `#B80C4E` | | `--code-num` | `#7C4DFF` |
| `--on-accent` | `#FFFFFF` | | `--viz-1` | `#F92672` |
| `--accent-tint` | `#FDE4EE` | | `--viz-2` | `#7C4DFF` |
| `--accent-tint-ink` | `#C60E56` | | `--viz-3` | `#4C8300` |
| `--accent-tint-2` | `#FFF3F8` | | `--viz-4` | `#A85E00` |
| `--accent-2` | `#7C4DFF` | | `--viz-5` | `#0A7E9C` |
| `--tile-1` | `#FBE3EC` | | `--tile-2` | `#FBB6CE` |
| `--tile-3` | `#F97BA8` | | `--tile-4` | `#F92672` |
| `--tile-5` | `#B8104E` | | | |

### Night (`[data-pb-theme="dark"]`, Monokai)

| Token | Value | | Token | Value |
|---|---|---|---|---|
| `--bg` | `#1E1F1C` | | `--deep` | `#15160F` |
| `--surface` | `#272822` | | `--deep-soft` | `#101109` |
| `--surface-alt` | `#2E2F28` | | `--deep-hover` | `#1C1D16` |
| `--hover` | `#33342C` | | `--deep-border` | `#3E3D32` |
| `--border` | `#3E3D32` | | `--nav-active-bg` | `#3E3D32` |
| `--border-soft` | `#36372F` | | `--nav-hover-bg` | `#2C2D26` |
| `--border-faint` | `#2F302A` | | `--deep-text` | `#F8F8F2` |
| `--border-strong` | `#4E4F42` | | `--deep-text-2` | `#D7D7CC` |
| `--track` | `#3E3D32` | | `--deep-muted` | `#A6A392` |
| `--track-off` | `#4E4F42` | | `--deep-faint` | `#9A9682` |
| `--text` | `#F8F8F2` | | `--ok` | `#A6E22E` |
| `--text-mid` | `#D7D7CC` | | `--ok-tint` | `#31401D` |
| `--text-muted` | `#A6A392` | | `--ok-ink` | `#A6E22E` |
| `--text-faint` | `#8B8878` | | `--warn` | `#FD971F` |
| `--text-dim` | `#75715E` | | `--warn-tint` | `#3E2F17` |
| `--accent` | `#F92672` | | `--err` | `#F92672` |
| `--accent-hover` | `#FF5C99` | | `--grey` | `#75715E` |
| `--accent-ink` | `#FF6FAA` | | `--code-str` | `#A6E22E` |
| `--accent-deep` | `#F92672` | | `--code-num` | `#AE81FF` |
| `--on-accent` | `#272822` | | `--viz-1` | `#F92672` |
| `--accent-tint` | `#3D2430` | | `--viz-2` | `#AE81FF` |
| `--accent-tint-ink` | `#FF8FBD` | | `--viz-3` | `#A6E22E` |
| `--accent-tint-2` | `#33222B` | | `--viz-4` | `#E6DB74` |
| `--accent-2` | `#AE81FF` | | `--viz-5` | `#66D9EF` |
| `--tile-1` | `#3A2630` | | `--tile-2` | `#6B2244` |
| `--tile-3` | `#A61A57` | | `--tile-4` | `#F92672` |
| `--tile-5` | `#FF77AC` | | | |

### Semantic constants (JS layer)
```
GOLD  = var(--warn)   GREEN = var(--ok)
RED   = var(--err)    GREY  = var(--text-dim)
```
Configurable prop `accent` (design-doc editor) offers alternatives: `var(--accent)` (default), `#C9761F`, `var(--accent-ink)`, `#A67C3D`.

### Global CSS (in `<style>`)
- `* { box-sizing: border-box; }`
- `a { color:var(--accent-ink); text-decoration:none; }` → hover `color:var(--accent); text-decoration:underline;`
- Scrollbar: `::-webkit-scrollbar { width:10px; height:10px; }`, thumb `background:var(--border-strong); border-radius:6px;`
- Print rules: `[data-print-hide]{display:none}`, `[data-print-keep]{position:static;padding:0}`, `body{background:#fff}`.

---

## 2. Typography

Font stacks:
- **UI text:** `'IBM Plex Sans', system-ui, sans-serif` (and `-apple-system…` in bundler chrome).
- **Code / paths / monospace values:** `'IBM Plex Mono', monospace`.
- **Wordmark + a couple of mono glyphs (the sidebar `N` for Nkoyo):** `'Cascadia Code', 'JetBrains Mono', 'IBM Plex Mono', monospace`.
- **Favicon / thumbnail wordmark:** `'JetBrains Mono', monospace` (and `'Cascadia Code', 'JetBrains Mono', monospace` in the SVG favicon).

### Embedded fonts (base64 woff2 in manifest — 22 font files total)
All delivered as `font/woff2`, `font-display: swap`, with full Google-Fonts unicode-range subsets (latin, latin-ext, cyrillic, cyrillic-ext, vietnamese, greek where applicable):

| Family | Weights embedded (all `normal` style) |
|---|---|
| **IBM Plex Sans** | 400, 500, 600, 700 |
| **IBM Plex Mono** | 400, 500 |
| **JetBrains Mono** | 400, 500, 700 |

**Cascadia Code is referenced in font stacks but NOT embedded** — it falls back to JetBrains Mono / IBM Plex Mono. It is only the *first* choice for the wordmark.

### Type scale observed (px, non-exhaustive but representative)
- Wordmark: 52px (login), 40px (mobile gate), 18px (sidebar), letter-spacing -2px / -1.6px / -0.5px, weight 700.
- Page H1 titles: 30px (Home greeting), 26px (Engines/section pages), 25px (Catalog/Create), 24px (Files/Settings), 23px (Dashboard), weight 600, letter-spacing ~ -0.4 to -0.6px.
- Section headings: 16px / 15px weight 600.
- Card/nav labels: 13.5px; table cells 13px; secondary 12.5px / 12px.
- KPI numbers: 26px (Home), 24px (dashboard KPI), 19px (catalog stat tiles), weight 600.
- Uppercase eyebrow labels: 10.5–11px, `letter-spacing:0.6–0.9px`, `text-transform:uppercase`, `color:var(--text-faint)`.
- Mono captions/paths: 11–13px.
- Line-heights: prose 1.6–1.8; code `<pre>` 1.75–1.85.

---

## 3. Layout & Shell

Root authed shell: `display:flex; min-height:100vh; width:100%; font-family:'IBM Plex Sans'; color:var(--text); background:var(--surface-alt);`

### Sidebar (left rail) — dark, sticky
- `width` bound to `sbWidth`: **236px expanded / 62px collapsed**. `transition:width .18s ease`. `background:var(--deep); color:var(--deep-muted); position:sticky; top:0; height:100vh;` `flex-direction:column`.
- **Header:** wordmark `p{b|es` (18px, Cascadia stack, per-character brand colors) + collapse chevron `«` (24×24, radius 6). Collapsed state shows a `»` expand button centered (26×26).
- **New button:** accent pill `+` `New`, radius 11, `background:var(--accent); color:var(--on-accent); font-weight:600; font-size:13px`. Hover `--accent-hover`.
- **Nav list:** groups with uppercase eyebrows (`Workspace`, `Analysis`, `Data engineering`, `Infrastructure`, `Admin`) hidden when collapsed. Each nav row: `padding:8px 10px 8px 8px; radius:10px; font-size:13.5px`.
  - **Active-dot marker:** a reserved 5×5 dot slot at the row start (`width:5px; height:5px; border-radius:50%; flex-shrink:0`). Its color is `--accent` when active, else `transparent` (slot always reserved so text never shifts). Active row also gets `background:var(--nav-active-bg)` and `color:var(--deep-text)`; inactive `color:var(--deep-muted)`, hover `background:var(--nav-hover-bg)`. Dot/label/group are hidden entirely when collapsed (`navJustify` becomes `center`).
  - Nav marker logic: `nav(id)` → `on = page===id || (id==='dashboards' && page==='dashboard')`.
- **Footer:** `Account & Settings` nav item (separated by `border-top:1px solid var(--deep-border)`) + mono version block `v0.4.1 · self-hosted / 4 hosts · 12 containers` (hidden when collapsed).

### Topbar — light, sticky
- `height:52px; flex:0 0 52px; background:var(--surface); border-bottom:1px solid var(--border); padding:0 18px; gap:16px; position:sticky; top:0; z-index:20;`
- Left: workspace chip `phd-prod` (mono 11.5px, `color:var(--accent-deep)`, bordered pill).
- Center: search field (max-width 560, height 32, radius 11, `background:var(--surface-alt)`) — `⌕ Search tables, notebooks, jobs…` with `⌘K` hint at right.
- Right cluster (`margin-left:auto; gap:10px`): **Nkoyo avatar button** (32×32 circle, 2px accent padding-ring, hidden on Nkoyo route and on notebook when not tight), **user chip `SI`** (29×29 circle, `background:var(--accent-deep); color:var(--deep-text)`), **theme toggle** (29×29, radius 11, glyph `☾`/`☀`), **sign-out** (29×29, radius 11, glyph `⏻`, hover border/color `--err`).

### Main column
`flex:1; min-width:0; display:flex; flex-direction:column;` → topbar, then `flex:1; display:flex; min-height:0` row containing the route content (`flex:1; min-width:0`) and the optional pinned **assistant panel** on the right.

### Workbench shell (JupyterLab-style — routes notebook / sql / dashboard / dashboards)
- **Icon rail:** `width:46px; flex:0 0 46px; z-index:31; border-right:1px solid var(--border); background:var(--surface-alt);` vertical, `gap:5px; padding:10px 0`. Four 32×32 radius-9 icon buttons (inline SVG, 1.5 stroke): **Files** (folder), **Table of contents** (switches between a "widgets" 4-shape icon on dashboards and a "headings" 3-line icon on notebooks), **Dashboards** (speech/chart), **Catalog** (database cylinder). Active button: `background:var(--accent-tint); color:var(--accent-tint-ink)`; idle `color:var(--text-faint)`.
- **Context panel:** `width:266px`, `background:var(--surface-alt)`, `border-right`. Position is `relative`/`266px` basis normally; when tight (`≤1279px`) it becomes `position:absolute; left:46px; top:0; bottom:0; z-index:30; box-shadow:6px 0 22px rgba(20,22,16,0.26)` (overlay) with a scrim backdrop `rgba(20,22,16,0.30)`. Panels: Files tree, Table of contents (headings/widgets), Dashboards list, Catalog tree. Each has a header row (uppercase title + `✕` close).
- **Document tabs (JupyterLab-like):** shown for notebook/sql only. Horizontal strip, `border-bottom:1px solid var(--border); background:var(--surface-alt); overflow-x:auto`. Each tab: `padding:9px 12px; border-right:1px solid var(--border); box-shadow:inset 0 2px 0 <mark>` (top accent bar when active), icon + name + `✕`, plus a `+` new-document button. Default open tabs: `03_cohort_attrition` (notebook ▧), `attrition_by_facility.sql` (sql ›_), `04_descriptive_stats` (notebook ▧).
- **Document body:** `flex:1; min-height:0; overflow-y:auto`.

### Responsive breakpoints
- **`max-width: 1279px` (`tight`):** workbench context panel switches from **push** (`relative`, reserves 266px) to **overlay + scrim** (`absolute`, z-30, shadow). The assistant stops being pinned open by default. Two `matchMedia` listeners drive `state.tight` and `state.narrow`.
- **`max-width: 699px` (`narrow`):** **mobile gate** — the whole app is replaced by a full-screen dark "Pebbles needs a bigger screen." panel (`background:var(--deep)`, `padding:36px 28px`): wordmark, headline, copy, a workspace-URL card (`https://pebbles.phd.health`) with "Copy link", reassurance bullets, and a mono footer `v0.4.1 · self-hosted`. `isAuthed`/`isLogin` are both gated to `!narrow`.
- Assistant panel auto-opens on the notebook route when not tight (`assistantOpen = (page==='notebook' && !tight) ? true : (assistant && page!=='nkoyo')`).

### Assistant panel (Nkoyo, right side)
- `width:340px; flex:0 1 340px; min-width:270px; border-left:1px solid var(--border); background:var(--surface); height:calc(100vh - 52px); position:sticky; top:52px;`
- Header: 30×30 avatar ring, "Nkoyo" + `local · engine analytics-md`, optional `✕`.
- Body: chat bubbles — user bubble `background:var(--deep-soft); color:var(--deep-text); border-radius:12px 12px 3px 12px` (right-aligned, max 82%); assistant bubble `background:var(--surface-alt); border:1px solid var(--track); border-radius:12px 12px 12px 3px` (max 92%). Suggestion pills, "Try next" list, footer input `Ask Nkoyo about your data… →`.

---

## 4. Component Styles

### Cards / panels
`background:var(--surface); border:1px solid var(--border); border-radius:14px` (12px for smaller stat tiles). List cards use `overflow:hidden` and internal rows split by `border-bottom:1px solid var(--border-soft)`. Dashboard widget cards add a drag handle `⠿` and a bottom-right resize nub (`border-right/-bottom:2px solid var(--border-strong); border-bottom-right-radius:14px`).

### Buttons
- **Primary / accent:** `background:var(--accent); color:var(--on-accent); border-radius:11px; font-weight:600; font-size:12.5–13.5px; padding:~7–12px 14–20px`. Hover `background:var(--accent-hover)`. (Login CTAs use radius 12.)
- **Deep/dark action** (e.g. Home "Ask", Nkoyo "New chat"): `background:var(--deep-soft); color:var(--deep-text); border-radius:11–12px`.
- **Secondary / ghost:** `border:1px solid var(--border); border-radius:11px; background:var(--surface); font-size:12.5px`. Hover `border-color:var(--accent)`.
- **Run (SQL):** accent button prefixed `▶`. Icon-only utility buttons (theme, sign-out): 29×29, radius 11, bordered.

### Inputs / selects / textareas
- Text input: `padding:11px 13px; border:1px solid var(--border); border-radius:12px; background:var(--surface); font-size:14px; font-family:'IBM Plex Mono'; color:var(--text); outline:none;` focus `border-color:var(--accent)`.
- Read-only "field" display boxes (settings/create): `padding:10px 12px; border:1px solid var(--border); border-radius:11px; background:var(--surface); font-size:13px`. An actively-edited field uses `border:1px solid var(--accent)`.
- Search fields: height 30–32, radius 9–11, `background:var(--surface)`/`--surface-alt`, leading `⌕` glyph, `color:var(--text-faint)`.
- Selects rendered as boxes with trailing `▾`.

### Tables
- Wrapper card radius 14, `overflow:hidden` (or `overflow-x:auto` with `min-width` for wide tables).
- Header row: `background:var(--surface-alt); border-bottom:1px solid var(--border); font-size:11–11.5px; font-weight:600; letter-spacing:0.5px; text-transform:uppercase; color:var(--text-faint); padding:10px 16px`.
- Body rows: `padding:10–12px 16px; border-bottom:1px solid var(--border-soft)` (or `--border-faint` for dense mono result grids); hover `background:var(--hover)`. Column values often use flex fixed widths; code/id columns are mono, types coloured `var(--viz-5)`.

### Badges / pills
- **Status pill (CERTIFIED):** `padding:3px 9px; border-radius:20px; background:var(--accent-tint); color:var(--accent-tint-ink); font-size:11px; font-weight:600`.
- **VERIFIED:** `background:var(--ok-tint); color:var(--ok-ink)`. **UNVERIFIED:** `background:var(--warn-tint); color:var(--warn)`. All radius 20, 10.5px, weight 600.
- **Filter chips (Home recents):** `padding:6px 13px; border-radius:20px`; selected = `background:var(--deep-soft); color:var(--deep-text)`; idle = `border:1px solid var(--border); background:var(--surface); color:var(--text-mid)`, hover `border-color:var(--accent)`.
- **Status dots:** small circles (7–8px) coloured `--ok`/`--warn`/`--err`/`--text-dim` for engine/host/job state.

### Tabs (in-page)
Horizontal row with `border-bottom:1px solid var(--border)`; active tab `padding:0 2px 10px; font-weight:600; border-bottom:2px solid var(--accent)`; inactive `color:var(--text-muted)`.

### Toggles / switches
Track `width:34px; height:19px; border-radius:14px; position:relative`. Knob `position:absolute; left:2px; top:2px; width:15px; height:15px; border-radius:50%; background:var(--on-accent)`. Off track `background:var(--track-off)`; on track uses `--track`/accent/`--ok`. (Small toggles at `width:34px` seen in job builder; larger accent switches in settings.)

### KPI tiles (Home)
4-up grid `grid-template-columns:repeat(4, minmax(0,1fr)); gap:12px`. Each tile: `background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:16px; flex-direction:column`. Uppercase eyebrow (`min-height:30px` to align), then big number 26px/600 with a small qualifier span.
- **The "$0 licence cost" tile is special:** `background:var(--deep-soft); border:1px solid var(--deep-soft); color:var(--deep-text)` (dark, inverted). Eyebrow "Licence cost" is `color:var(--accent)`; value `$0` with `/ month` in `--deep-muted`. Other tiles: `Engines running 3 / 6`, `Jobs today 14 · 1 failed` (failed in `--err`), `Lake size 2.4 TB parquet`.

### Nkoyo avatar
A **charcoal silhouette of a woman's head in profile (afro, facing left)** on a cream background — embedded 256×256 `image/png` (manifest key `a935ac35…`). Always shown inside an **accent ring**: outer circle `background:var(--accent); border-radius:50%; padding:2px/3px`, image `object-fit:cover; border:2–3px solid var(--surface)`. Sizes: 72px (Nkoyo hero), 32px (topbar/ask bar), 30px (panel header), 28px (Home ask bar).

### Toasts / empty states
No dedicated toast component found. "Empty/help" states are inline muted hints, e.g. `Right-click a file for actions`, `Drag a table into a cell to insert its name`, `An empty schema is valid` — 11px `color:var(--text-dim)`. Context menu is a positioned card driven by right-click delegation (`data-ctx` attribute) at `{x,y}`.

---

## 5. Routes / Screens

`Component.ROUTES` (persisted as `pebbles.route.v4` in localStorage; restored only if known):
```
home, nkoyo, workspace, catalog, newcatalog, autoetl, groups, jobbuilder,
notebook, sql, dashboards, dashboard, jobs, run, ingest, engines,
engineconfig, hosts, users, usage, settings
```
Plus auth/gate pseudo-routes: **login** (2-step), **mobile gate** (narrow).

- **login** — Split screen. Left 46% dark panel (`--deep`): wordmark 52px, tagline "Your lake, your engines, your hardware.", copy, mono footer `v0.4.1 · self-hosted / node-01 · docker + lxc`. Right: centered 370px form. Step 1 = username (mono input, "Continue"); Step 2 = avatar chip + password + "Sign in" + "Forgot password?". Error banner uses `--accent-tint`/`--err`. Demo creds hint: `admin / isantm`. (Auth: username must be `admin`, password `isantm`.)
- **home** — `max-width:1080px; margin:0 auto; padding:34px 40px 60px`. Date eyebrow, greeting "Good afternoon, Sunday" (30px). 4 KPI tiles (incl. `$0 licence cost`). **Nkoyo ask bar** (avatar + placeholder + deep "Ask" button). Filter chips (Recents/Favourites/Shared/Popular). Recents list card (icon, name, mono path, when, type).
- **nkoyo** — Chat page `height:calc(100vh - 52px)`. Left 250px history sidebar (+ New chat, Recent list, "runs in-cluster on node-04" note). Center empty-state: 72px avatar, greeting, 720px ask box with `@ table / ▧ notebook / ◍ analytics-md` chips + `→` send, then a 2×2 grid of suggestion cards. Footer disclaimer.
- **workspace (Files)** — Left 266px tree (Home / Shared / Workspace / Favourites / Trash). Main: breadcrumb, title `Home` + mono quota `/home/sikpe on node-01 · uid 1007 · 41.2 / 200 GB`, Share + `Create ▾` buttons, filter bar, files table (Name/Type/Owner/Last updated).
- **catalog** — **"Money shot" browser.** Left 290px tree (attached-engine card with green dot, search, `phd_lake › bronze/silver/gold` with expandable tables). Main: breadcrumb, table title `claims_line` + `CERTIFIED` pill, action buttons (Permissions/Lineage/New catalog/Query), 5 stat tiles (Rows/Size/Format/Snapshot/Owner), in-page tabs (Schema/Sample/Snapshots/Lineage/Permissions), schema table (Column/Type/Nulls/Comment), Recent snapshots list with "Time travel →". (The US **map cartogram** lives on the **dashboard** route, not catalog — see below.)
- **newcatalog (Create Catalog)** — Two-column. Left form (name/owner/storage-root/table-format fields, Schemas list with ✓, Access grants, Create/Cancel). Right **live "Equivalent SQL"** dark card (`background:var(--deep)`): syntax-highlighted `CREATE CATALOG / CREATE SCHEMA / GRANT` (`--accent` keywords, `--code-str` strings) that mirrors the form, plus "Open in SQL editor".
- **notebook** — Workbench route. Header with path, cells (markdown + code + outputs). Table-of-contents panel shows notebook headings. Assistant pinned when wide.
- **sql (SQL Editor)** — Header (filename, engine pill `sql-small ▾`, Save, `▶ Run`). Syntax-highlighted `<pre>` query (mono 13px, keywords `--accent-ink`, strings `--code-str`, numbers `--code-num`). Result meta bar (`✓ 50 rows / 1.9 s / scanned 41.2 GB / Download CSV / Add to dashboard`) then mono result table.
- **dashboards** — Grid/list of dashboard cards, each with mini bar sparkline preview (b1..b5 heights) + meta line.
- **dashboard (view)** — **The d3-flavoured "money shot".** Header (‹ Dashboards, title "Patient Demographics 2026", Reset layout / Full-screen / Download PDF / Share). 4-col grid of **draggable, resizable** widgets: **MAP** (US tile-grid cartogram — schematic Albers-USA-style, 51 `<path>` tiles from `Component.TILES` / `window.US_STATES`, filled from `--tile-1..5` scale with a Fewer↔More legend, label "albers usa"/"claim volume by state"), **LINE** (area+polyline+dots claim-lines/month), **KPI** (Patients/Median age/Allowed PMPM/Readmit), **DONUT** (payer mix), **PYRAMID** (age & sex). Drag-reorder via `draggable` + dragover splice; resize via pointer-down on corner nub; full-screen sets `position:fixed; inset:0; z-index:70`. Print/PDF via `window.print()`. Share modal lists people/groups with access levels.
- **jobs** — "Jobs & Workflows" title, filter, jobs table (status dots, schedules).
- **jobbuilder** — ‹ Jobs breadcrumb, builder form incl. cron field (`0 1 1 * *`) and toggle switches (Catch up missed runs / Allow overlapping runs).
- **run (Job Run Detail)** — ‹ Jobs, "Claims Monthly Refresh", run bar chart (20 bars; indices 3/9/12 = `--err` red, >13 = green, else `--accent-ink`), task timeline, logs (with `OOM` in `--err`).
- **ingest (Data Ingestion)** — Title + "New connection", connections list.
- **autoetl (Auto ETL)** — ‹ Data Ingestion; profile columns table, cleaning-steps checklist (✓ done vs unfinished), star-schema model tables (FACT/DIM colour-coded `--accent`/`--accent-deep`).
- **engines** — Title + "Create engine", tabs (All/Job/SQL/Policies), engines table (Availability dot + state, Name w/ lock glyph, Size, Host mono, In use by, action). Row → engineconfig.
- **engineconfig** — ‹ Engines, "analytics-md" config detail (size/host/limits, toggles).
- **hosts** — Title + "Add host", hosts table (node-01..04, Docker/LXC backends, subnets, engine counts, Connected/Draining state).
- **users (Users & Access)** — Title, users/access management table.
- **groups** — Groups list (analytics/data-eng/platform/clinical/vendors/service), members, grants panel.
- **usage (Resource Usage)** — Title + copy "What your own hardware is doing. No credits, no metering, no invoice." 30-bar usage chart (`--viz-2` when >75%, else `--viz-1`).
- **settings (Account & Settings)** — Left 236px tab sidebar (avatar `SI`, Profile / Security & sessions / Home directory / Nkoyo model / Agent skills / API tokens / — Workspace·admin — / Compute runtime / Sign out). Right pane per tab: Profile field grid + preference rows with toggles; Security = sessions/tokens; Nkoyo model = Ollama model list (`llama3.1:70b`, `qwen2.5-coder:32b`, etc.); Skills list (Enabled/Enforced/Disabled); Tokens table; Runtime = host list.

---

## 6. Iconography

- **Nav/UI glyphs are Unicode characters**, not an icon font or (mostly) SVG — e.g. Home `⌂`, Files `▤`, Catalog `◨`, Notebooks `▧`, SQL `›_`, Dashboards `▦`, Jobs `⇄`, Ingestion `⇥`, Engines `◍`, Hosts `▥`, Users `◔`, Groups `◕`, Usage `◑`, Settings `⚙`; table `▤`, folder `▸`/`📁`, search `⌕`, close `✕`, refresh `⟳`, collapse `«`/`»`, drag handle `⠿`, send `→`. Nkoyo's sidebar mark is a Cascadia `N` in `--accent`.
- **The workbench icon rail uses inline SVG** (16×16 viewBox, `stroke=currentColor; stroke-width:1.5; stroke-linecap/linejoin:round`): folder (Files), 3-line/4-shape (ToC headings vs widgets), speech-chart (Dashboards), database cylinder (Catalog).
- **Charts are inline SVG**: dashboard map `<svg viewBox="0 0 900 520">` of `<path>` tiles; line chart `<svg viewBox="0 0 600 380">` area+polyline+`<circle>` dots; bar charts are flex `<div>` columns with `%` heights.
- **Wordmark `p{b|es`**: per-character colors — `p` `#A6E22E`, `{` and `|` foreground (`#F8F8F2` on dark), `b` `#FD971F`, `es` `#F92672`; Cascadia stack, 700, tight negative letter-spacing (≈ -0.04em). **Favicon** is an inline SVG data-URI: rounded-rect `#272822` bg (rx 14), glyph `{b|` where `{`/`|` are `#F8F8F2` and `b` is `#FD971F`, font Cascadia/JetBrains Mono 34px/700. The bundler thumbnail/splash shows the full `p{b|es` wordmark on `#1E1F1C`.

---

## 7. Motion

- **Sidebar collapse/expand:** `transition:width .18s ease` on the rail (236↔62px). Label/dot/group visibility toggles via `display`.
- **Dashboard interactions:** HTML5 drag-and-drop reorder (`draggable`, `dragstart/dragover/dragend`), live splice on `dragover` (dragged card `opacity` lowered while dragging); pointer-driven corner **resize** changing grid span; full-screen toggle swaps to `position:fixed; inset:0; z-index:70`.
- **Hover states** everywhere via `style-hover=` (border→`--accent`, bg→`--hover`/`--accent-hover`/`--nav-hover-bg`), no explicit transition duration on most (instant), relying on the templating layer.
- **Panel overlay** (tight breakpoint) uses a static `box-shadow:6px 0 22px rgba(20,22,16,0.26)`; no slide animation declared.
- No keyframe animations, spinners, or CSS `@keyframes` found — motion is limited to the width transition, DnD, and hover recolours. Theme switch is instant (`data-pb-theme` attribute swap; persisted to `pebbles.theme`).

---

## Appendix — implementation notes for rebuild
- Everything is CSS-variable-driven; implement the two token blocks and switch via a `data-pb-theme` attribute on `<html>` (persist to localStorage `pebbles.theme`, default `light`).
- Reserve the nav active-dot slot (5px) always, colour it only when active, to avoid text reflow.
- The `$0 licence cost` KPI tile is deliberately inverted (dark) among 3 light tiles — keep that contrast.
- Two breakpoints only: **699px** (mobile gate — replace whole app) and **1279px** (workbench panel overlay + unpin assistant).
- Fonts to load: IBM Plex Sans (400/500/600/700), IBM Plex Mono (400/500), JetBrains Mono (400/500/700). Cascadia Code optional/first-choice for wordmark only.
- The US map is a **schematic tile cartogram**, not real geography — 51 rounded square/path tiles laid out on a 7-row grid (see `Component.TILES` for row/col of each state), filled by a 5-step tile scale.
