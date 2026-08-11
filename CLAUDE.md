# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Pebbles: a self-hosted data platform (data lake + notebooks + pipelines + dashboards) positioned as a free alternative to Databricks/Snowflake, running on hardware the user already owns. **No backend or application code exists yet** — the repo currently holds product documents and an interactive UI prototype. There is no build system, linter, or test suite to run.

## Documents and their authority

Each document is the source of truth for a different concern. When they conflict, defer accordingly:

- `pebbles-spec-v2.md` — **source of truth for UX and technical/architecture decisions.** Statements carry confidence markers: `[decided]`, `[new]`, `[built]`, `[proposed]` (design judgement awaiting confirmation), `[open]` (undesigned). Do not treat `[proposed]`/`[open]` items as settled.
- `pebbles-prd.md` — what/why/priority. Stable requirement IDs (REQ-01…REQ-50, NFR-01…NFR-08) with P0/P1/P2 priorities and release phasing (Phase 0 → 3). Reference requirements by ID.
- `ui_ux.html` — the v15 interactive prototype (source of truth for **visual design**). A self-extracting single-file bundle (React + d3); open it in a browser, don't try to read it as source. Sample data only — every number and username in it is fake.
- `CHANGELOG.md`, `HOWTO.md` — currently empty placeholders.

## Planned architecture (from spec v2)

- **One container image, role at first boot**: `PEBBLES_ROLE=main` (control plane: Postgres catalog, Airflow scheduler, Flask UI, `pebblesd` supervisor) or `PEBBLES_ROLE=engine` (compute: `pebblesd` + kernels). Engines join the main via single-use tokens.
- **`pebblesd` (Rust)** — the only privileged component. Owns container sockets, UNIX account provisioning, session brokering, git-as-user, health loops. **`Flask` (Python)** — thin stateless web tier; NFR-01 boundary rule: Flask never touches container sockets, never runs as root, never spawns user processes — everything privileged goes through `pebblesd`'s API.
- **Identity = UNIX accounts.** Pebbles users are real host accounts; sessions run as the user's uid/gid with their home bind-mounted at `/workspace`; all grants target UNIX groups (per-user grants use the personal primary group). There is deliberately no second ACL system.
- **Compute = "Engines"** running DuckDB (not Spark). Engines host multiple concurrent sessions (one process per user); dedicated sessions are opt-in and contention resolves by **draining** — never refusal, never preemption.
- **Storage = DuckLake**: plain files + Postgres catalog, with snapshot time travel.
- **Jobs = Airflow, hidden.** Workflows compile to DAGs; operators call `pebblesd` to "run X on engine Y as user Z". Users never see Airflow's UI.
- **Nkoyo** — the AI assistant, an agent harness on local Ollama models only; approval-gated (Auto ETL runs nothing before the user approves). No data leaves the hosts; the product must work fully air-gapped (NFR-03).

## Fixed conventions

- **Vocabulary**: the UI says **Lake** and **Engine** — never "cluster", never "credits"; "DuckDB" appears only in detail views. Naming is `catalog / schema / table`.
- **Design system**: Monokai dual theme via CSS custom properties on `[data-pb-theme]`, accent pink `#F92672`, IBM Plex Sans/Mono, wordmark `pe{b}les` in Cascadia Code. No hard-coded colors in components.
- **Responsive rules**: hard gate below 700px viewport (not a mobile product); at <1280px workbench rail panels overlay with a scrim, at ≥1280px they push and dock.

## Hard-won implementation landmines (spec §9 — do not reintroduce)

- No `min-height:100%` inside scrolling flex columns; no `aspect-ratio` in nested auto-row grids (both caused browser-freezing layout loops).
- Route restore uses a boot sentinel, not a timer; route storage key is versioned (`pebbles.route.v4`) — bump on any route removal.
- The US map is baked geometry compiled into the bundle at build time; never fetch it at runtime.
