# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Pebbles: a self-hosted data platform (data lake + notebooks + pipelines + dashboards) positioned as a free alternative to Databricks/Snowflake, running in containers (Docker, rootful Podman, or LXC via Incus) on hardware the user already owns. The repo holds the product documents and the Phase 0 scaffold: Rust workspace, Flask web skeleton, Containerfile, deploy examples, and CI.

## Commands

```sh
cargo test                       # build + test the whole Rust workspace
cargo fmt --check                # formatting (CI-enforced)
cargo clippy -- -D warnings      # lints (CI treats warnings as errors)
cargo test -p pebbles-identity   # single crate; add `<name>` after for a single test

cd web && uv sync                # Python setup (uv-managed)
uv run ruff check .              # Python lint
uv run pytest                    # Python tests (single test: uv run pytest -k <name>)

cd web/frontend && npm ci        # React UI setup
npm run typecheck && npm run build   # TS check + build into pebbles_web/static/app
npm run dev                      # Vite dev server, /api proxied to :8080

scripts/dev/run.sh               # native dev loop: pebblesd + Flask, scratch config dir
docker build -f image/Containerfile -t pebbles:dev .   # image build (CI does this normally)
scripts/smoke/install-to-first-query.sh pebbles:dev    # boot + health-check the image
```

## Documents and their authority

Each document is the source of truth for a different concern. When they conflict, defer accordingly:

- `pebbles-spec-v2.md` — **source of truth for UX and technical/architecture decisions.** Statements carry confidence markers: `[decided]`, `[new]`, `[built]`, `[proposed]` (design judgement awaiting confirmation), `[open]` (undesigned). Do not treat `[proposed]`/`[open]` items as settled.
- `pebbles-prd.md` — what/why/priority. Stable requirement IDs (REQ-01…REQ-50, NFR-01…NFR-08) with P0/P1/P2 priorities and release phasing (Phase 0 → 3). Reference requirements by ID.
- `pebbles-implementation-plan.md` — **source of truth for how it gets built**: stack, repo layout, runtime strategy (Docker/Podman/Incus, uid model, capabilities), image engineering, CI/CD design, Phase 0 milestones (M0.1–M0.6), and resolutions of spec `[proposed]`/`[open]` items.
- `ui_ux.html` — the v15 interactive prototype (source of truth for **visual design**). A self-extracting single-file bundle (React + d3); open it in a browser, don't try to read it as source. Sample data only — every number and username in it is fake.

**Keep docs in sync while building:** update `README.md`, `CHANGELOG.md`, `HOWTO.md`, and `pebbles-prd.md` as required with every change that affects behavior, usage, or scope — treat it as part of the definition of done, not a separate task.

## Architecture

- **One container image, role at first boot**: `PEBBLES_ROLE=main` (control plane: Postgres catalog, Airflow scheduler, Flask UI, `pebblesd` supervisor) or `PEBBLES_ROLE=engine` (compute: `pebblesd` + kernels). Role is sticky in the config volume (`/var/lib/pebbles`). Engines join the main via single-use tokens. **`pebblesd` is PID 1** in the container (also symlinked `/sbin/init` for Incus).
- **`pebblesd` (Rust)** — the only privileged component. Owns container sockets, UNIX account provisioning, session brokering, git-as-user, health loops. Crates: `pebblesd` (binary), `pebbles-api` (API types → OpenAPI), `pebbles-runtime` (`ContainerRuntime` trait + drivers), `pebbles-identity` (uid allocator, reserved range 70000–74999 per `docs/adr/ADR-001-uid-range.md`, shadow-based password verification), `pebbles-session` (broker, memory admission). **Web tier (Python, `web/`)** — Flask serves the **React SPA** (built from `web/frontend/` into `pebbles_web/static/app`, owning `/` and every non-API path) plus the JSON surface under `/api` (`pebbles_web/api.py`); NFR-01 boundary rule: Flask never touches container sockets, never runs as root, never spawns user processes — everything privileged goes through the hand-written stdlib-only `pebblesd_client.py`, which mirrors pebblesd's routes one-to-one (change both in the same commit; there is no generated client). Frontend: Vite + React 18 + TS, inline styles on CSS custom properties only.
- **Runtime support**: Docker and rootful Podman share one `bollard` driver (docker-compat socket); LXC targets **Incus** via a thin REST client. Rootless Podman is detected and refused in v1 (subuid remapping breaks the uid-consistency invariant, REQ-11). Incus engines run unprivileged with a 1:1 `raw.idmap` of the reserved uid range. Engine containers need SETUID/SETGID/CHOWN/FOWNER/DAC_OVERRIDE/KILL and must NOT set `no-new-privileges`.
- **Identity = UNIX accounts.** Pebbles users are real host accounts in the reserved uid range; sessions run as the user's uid/gid with their home bind-mounted at `/workspace`; all grants target UNIX groups (per-user grants use the personal primary group). There is deliberately no second ACL system. `kernels/` binaries run *as end users* on engines — nothing in `web/` executes on an engine.
- **Compute = "Engines"** running DuckDB (not Spark) with DuckLake storage (Parquet + Postgres catalog, time travel). Engines host multiple concurrent sessions (one process per user); dedicated sessions are opt-in and contention resolves by **draining** — never refusal, never preemption. DuckDB/DuckLake versions are pinned and extensions vendored into the image — no runtime `INSTALL` (NFR-03, air-gapped).
- **Jobs = Airflow 3.x, hidden** (Phase 1; separate venv). Workflows compile to DAGs; operators call `pebblesd` to "run X on engine Y as user Z". Users never see Airflow's UI.
- **Nkoyo** — the AI assistant, an agent harness on local Ollama models only; approval-gated. No data leaves the hosts.
- **CI/CD does the heavy lifting**: image built once (native amd64+arm64, no QEMU), converted once to the Incus artifact, the same digest tested across the runtime × topology matrix by `scripts/smoke/install-to-first-query.sh`, size budget (`image/budgets.json`) hard-gated per PR, releases promote — never rebuild.

## Fixed conventions

- **Vocabulary**: the UI says **Lake** and **Engine** — never "cluster", never "credits"; "DuckDB" appears only in detail views. The LXC backend is called **Incus** in code/docs/deploy. Naming is `catalog / schema / table`.
- **Design system**: Monokai dual theme via CSS custom properties on `[data-pb-theme]`, accent pink `#F92672`, IBM Plex Sans/Mono, wordmark `pe{b}les` in Cascadia Code. No hard-coded colors in components.
- **Responsive rules**: hard gate below 700px viewport (not a mobile product); at <1280px workbench rail panels overlay with a scrim, at ≥1280px they push and dock.

## Hard-won implementation landmines (spec §9 — do not reintroduce)

- No `min-height:100%` inside scrolling flex columns; no `aspect-ratio` in nested auto-row grids (both caused browser-freezing layout loops).
- Route restore uses a boot sentinel, not a timer; route storage key is versioned (`pebbles.route.v4`) — bump on any route removal.
- The US map is baked geometry compiled into the bundle at build time; never fetch it at runtime.
