# Pebbles — Product Requirements Document

**Version:** 1.0 · **Date:** August 2026 · **Status:** Draft for review
**Companion documents:** `pebbles-spec-v2.md` (design & architecture detail — the source
of truth for UX and technical decisions), `ui_ux.html` (interactive prototype —
the source of truth for visual design), `pebbles-implementation-plan.md` (stack, repo
layout, container-runtime strategy, CI/CD, and Phase 0 milestones).

This PRD states *what* Pebbles must do and *why*, in what order, and how we will know it
works. Where the spec already fixes a design, this document references it rather than
restating it. Requirement IDs (REQ-xx) are stable and intended for issue-tracker import.

---

## 1. Problem statement

Teams that want a modern data platform — a lake, notebooks, scheduled pipelines,
dashboards — face a bad set of choices:

- **Databricks / Snowflake:** excellent products with per-second compute billing and
  licence costs that are hard to predict and hard to justify for small-to-mid teams,
  plus data leaving the building.
- **Self-assembled open source:** Jupyter + Airflow + MinIO + Superset + Keycloak is
  months of glue work, five permission systems, and no coherent UX.
- **Doing nothing:** analysts pass CSVs around and run pandas on laptops.

Meanwhile the hardware to run real workloads — retired servers, workstations, a Proxmox
box — is already sitting in the rack, costing nothing.

**Pebbles is one installable product that turns hardware you already own into a complete
data platform.** No licence, no metered compute, no data leaving your network.

## 2. Product vision

A self-hosted alternative to Databricks that a small team can install in an afternoon:
one container image, one setup question ("is this the main, or an engine?"), and you have
a lake with time travel, multi-user notebooks, drag-and-drop pipelines, dashboards, git
integration, and a local AI assistant — all governed by one identity system (UNIX
accounts) instead of a parallel permissions maze.

**Positioning line:** *"$0 licence cost"* — it is literally a KPI tile on the home screen.

## 3. Goals and non-goals

### Goals
1. **Install-to-first-query in under one hour** on a single machine (Docker or LXC).
2. **Zero marginal cost of compute** — adding an engine is registering another container,
   not a billing event.
3. **One permission system** — UNIX users, groups and filesystem permissions govern
   files, data, and compute alike.
4. **Team-ready concurrency** — multiple users share engines safely by default, with
   opt-in exclusive use.
5. **Everything on-premises** — including the AI assistant (Nkoyo runs on local Ollama
   models; no data leaves the hosts).
6. **Reproducibility** — notebooks and pipelines live in git; approved ETL becomes a
   versioned, re-runnable artifact.

### Non-goals (v1)
- Not Spark and not distributed query execution; the engine is DuckDB, scaled by giving
  it bigger machines and more engines, not by sharding a query.
- Not a mobile product (hard gate below 700px viewport).
- Not a SaaS; no hosted offering, no external/public dashboard sharing.
- Not a general container orchestrator; Pebbles manages only its own containers.
- No high-availability control plane; if the main is down, running sessions continue but
  nothing new starts ("degraded but alive").

## 4. Target users

| Persona | Description | What they need |
|---|---|---|
| **Ade — platform owner / admin** | The person who installs Pebbles; part-time infra, part-time data. | One-command install; register machines as engines; create users/groups; assign compute to teams; see host utilisation; sleep at night knowing permissions are just UNIX. |
| **Maya — analyst** | SQL-first, dashboard-heavy, non-infra. | Log in, attach to an engine, query the lake, build and rearrange dashboards, never think about containers. |
| **Tomas — data engineer** | Python/SQL, owns pipelines. | Clone a repo, develop notebooks against a shared engine, wire tasks into a scheduled workflow, mark a heavy stage dedicated, push to GitHub from the UI. |
| **Dr. Okafor — data scientist** | R and Python, occasionally GPU. | A GPU engine assigned to her group only; dedicated sessions for training runs; R as a first-class kernel. |

Sample data domain throughout the product and demos: healthcare claims.

## 5. Requirements

Priorities: **P0** = MVP, cannot ship without · **P1** = v1.0 release · **P2** = fast-follow.

### 5.1 Installation & topology

| ID | Requirement | Priority |
|---|---|---|
| REQ-01 | Ship **one container image** containing all services (Rust daemon `pebblesd`, Flask web app, DuckDB, Python + SQL kernels, Airflow, git). | P0 |
| REQ-02 | Image runs under **Docker, Podman and LXC (via Incus)**; all three are supported install targets and engine backends simultaneously. Podman support is rootful-only in v1 (rootless uid remapping breaks REQ-11; detected and refused with guidance). | P0 |
| REQ-03 | **Role selected at setup**: `main` or `engine`, via env var / cloud-init (scripted) or terminal wizard (interactive). Role is sticky in the config volume. Exactly one main per workspace. | P0 |
| REQ-04 | The main can optionally serve engine sessions itself, so a **single-container install is a complete product**. Admin toggle governs this. | P0 |
| REQ-05 | Engines register **on the main** using a **single-use join token** (default 24 h expiry, one engine per token; tokens listed/revocable in admin settings; mintable via API for scripted fleets). | P0 |
| REQ-06 | A container that contacts the main without a valid token appears as **Pending approval** for admin approve/reject. | P1 |
| REQ-07 | At registration (and editable later), an engine is assigned **access**: everyone, a group, or a single user. Only grantees can see or attach it. | P0 |
| REQ-08 | Deregistering an engine (Remove on the Engines list) invalidates its credentials. | P1 |
| REQ-09 | Upgrade = pull new image, restart with same config volume; catalog schema migrations run automatically with pre-migration backup. | P1 |
| REQ-10 | R kernel ships **in the image** via miniforge (REQ-51); the earlier in-image vs. optional-layer scoping is resolved. | P0 |
| REQ-51 | **Python, R and Jupyter runtimes ship in-image via miniforge (conda-forge)** at `/opt/conda`; session kernels (SQL/Python/R cells) use these runtimes. Users can install additional packages without admin help (`pip install --user`, personal conda envs in their home) — the bundled set is a floor, not a wall. | P0 |
| REQ-52 | **Bundled out of the box** — Python: numpy, pandas, scipy, statsmodels, scikit-learn, matplotlib, seaborn, plotnine, geopandas, duckdb, polars, networkx, pmdarima, xgboost, openpyxl. R: r-essentials, r-gtsummary, r-arrow, r-duckdb, r-tidymodels, r-survey. Versions pinned per release; the image size budget is sized for this stack. Python is 3.12 while pmdarima lacks 3.13 builds; r-duckdb is amd64-only until conda-forge ships aarch64 builds (arm users: `install.packages("duckdb")`). | P0 |

### 5.2 Identity, users & access

| ID | Requirement | Priority |
|---|---|---|
| REQ-11 | Creating a Pebbles user provisions a **real UNIX account** (`/home/<user>`, uid, gid). Uid/gid consistent across all registered hosts; the main is the source of truth and replicates on registration and change. | P0 |
| REQ-12 | Engine session processes run as the **requesting user's uid/gid** with their home bind-mounted at `/workspace`. Containers hold no user accounts of their own. | P0 |
| REQ-13 | **All grants target UNIX groups.** Per-user grants are implemented as the user's personal primary group; the UI may display "«Name» only". Grants can target a catalog, a schema, or an engine. | P0 |
| REQ-14 | Group membership changes (`usermod -aG`) propagate to every registered host; sessions started afterwards inherit them. | P0 |
| REQ-15 | The Pebbles password is the same credential as SSH/SFTP to the host account; files dropped over SFTP appear in the Files screen. | P1 |

### 5.3 Compute & sessions

| ID | Requirement | Priority |
|---|---|---|
| REQ-16 | An engine hosts **multiple concurrent sessions**, one process per attached user, each under that user's uid, up to a configured **max sessions**. | P0 |
| REQ-17 | **Engine choice is always explicit** — the user picks from the Engines list; no automatic placement in v1. | P0 |
| REQ-18 | **Dedicated sessions**: opt-in at attach; while held, no other session may start; auto-release after 30 min idle. Per-engine toggle to allow/disallow dedicated. | P0 |
| REQ-19 | **Dedicated contention resolves by draining**: no new shared sessions admitted; existing sessions finish or idle out; running work is never killed; reservation is visible and cancellable; requester notified after a configurable wait (default 15 min); one reservation per engine. | P0 |
| REQ-20 | Per-session DuckDB `memory_limit`; new sessions refused when the sum of limits would exceed the container's memory; dedicated sessions may claim the full allowance. | P0 |
| REQ-21 | Per-engine config: memory limit, CPU limit, scratch volume, host pinning, auto-stop on idle, enabled kernels, access, max sessions, allow-dedicated. | P0 |
| REQ-22 | Engine health check every 10 s; lost engines flagged in UI; main-managed engines auto-restarted. | P1 |
| REQ-23 | Engines list shows the revised state model: Attached (shared/dedicated), In use, **Draining**, Dedicated-to-user, Available, Pending approval, Stopped, No access — with the correct action per state (spec §3). | P0 |

### 5.4 Storage & catalog

| ID | Requirement | Priority |
|---|---|---|
| REQ-24 | Lake storage is **DuckLake**: plain files with the catalog in Postgres on the main. Tables carry snapshots with **time travel**. | P0 |
| REQ-25 | Create Catalog via form **or** SQL (`CREATE CATALOG` / `CREATE SCHEMA` / `GRANT`); the form shows the equivalent SQL live. Both paths are the same operation. | P0 |
| REQ-26 | Catalog storage roots must be reachable from every engine; engine registration verifies reachability and fails loudly if the lake path is absent. Multi-host storage guidance (NFS / object storage) documented; design pending (§9). | P0 (verify) / P1 (multi-host design) |
| REQ-27 | UI vocabulary: **Lake**, **Engine**, `catalog / schema / table`. "DuckDB" appears only in detail views. Usage screens show host resource use, never "credits". | P0 |

### 5.5 Workbench (notebooks, SQL, dashboards)

| ID | Requirement | Priority |
|---|---|---|
| REQ-28 | Notebook editor with Python, SQL (P0) and R (P1) cells; SQL editor with results grid; dashboard gallery and rearrangeable single-dashboard view. | P0 |
| REQ-29 | All four analysis routes share one shell: 46 px icon rail with Files, Contents (context-sensitive), Dashboards, Catalog, and **Source control** panels; JupyterLab-style routing document tabs. | P0 |
| REQ-30 | Responsive rule: below 1280 px rail panels overlay with a scrim and the Nkoyo drawer unpins; above 1280 px panels push and dock. Panels folded by default at every width; navigation closes an overlaying panel. | P0 |
| REQ-31 | Cell output and job logs stream live (SSE/WebSockets). | P0 |

### 5.6 Git

| ID | Requirement | Priority |
|---|---|---|
| REQ-32 | **Clone from GitHub** into `~/repos/<name>` from the Files screen (paste URL, pick destination). Repos are ordinary directories: visible in Files, on engines at `/workspace/repos/<name>`, and over SFTP. | P0 |
| REQ-33 | All git operations execute **as the requesting user's uid** using credentials in their home (`~/.ssh` key or HTTPS PAT). Pebbles never holds a shared GitHub credential. | P0 |
| REQ-34 | Settings → Git: commit name/email, SSH keypair generation with copyable public key, PAT storage (0600 in user home). | P0 |
| REQ-35 | **Source control rail panel**: branch display + switcher, ahead/behind, changed-file list with click-to-stage, diff as a document tab, commit message, Commit / Commit & push / Pull. Git status badges in the Files tree. | P0 |
| REQ-36 | Merge conflicts: "take mine / take theirs / open file" only; full merge tooling out of scope. | P1 |
| REQ-37 | Workflow tasks can reference a notebook **in a repo at a ref** for reproducible pipelines. | P1 |

### 5.7 Jobs & workflows

| ID | Requirement | Priority |
|---|---|---|
| REQ-38 | Workflows compile to **Apache Airflow** DAGs; Airflow runs on the main and is **invisible** — the Pebbles Jobs UI is the only user-facing surface. | P0 |
| REQ-39 | Drag-and-drop DAG builder; task types: notebook, SQL, shell, nested workflow. Per-task: engine, parameters, retries, **session mode (shared default / dedicated)**. | P0 |
| REQ-40 | Per-workflow: trigger (scheduled / manual / on-file), cadence with resolved cron shown, catch-up, overlap policy, timeout, failure notification. **Test run** and **Save & run** are separate actions. | P0 |
| REQ-41 | Airflow operators execute tasks via `pebblesd` — "run X on engine Y **as user Z**" — so jobs obey the same identity and permission rules as interactive sessions. | P0 |
| REQ-42 | Run detail view with per-task status, logs, and run-duration history. | P0 |

### 5.8 Nkoyo (assistant) & Auto ETL

| ID | Requirement | Priority |
|---|---|---|
| REQ-43 | Nkoyo is an **agent harness** on local models: Ollama endpoints auto-detected across the fleet, rescan + manual add; separate models for planning, code/SQL, embeddings; max-steps cap. **No data leaves the hosts.** | P1 |
| REQ-44 | Folder-based skills: `~/.pebbles/skills` (personal), `/opt/pebbles/skills` (workspace); a skill = `SKILL.md` + scripts, hot-loaded next turn; org skills can be enforced. | P1 |
| REQ-45 | Tool permissions graded always-on / ask-first / blocked; Nkoyo can never exceed the invoking user's own grants. Git tools default to ask-first. | P1 |
| REQ-46 | **Auto ETL**: drop a raw dataset → profile → propose star schema → propose cleaning steps → **user approves** → load. Nothing runs before Approve & run; low-confidence steps arrive unticked with confidence shown; result saveable as a repeatable pipeline and committable to a repo. | P1 |
| REQ-47 | Nkoyo placement: tucked away everywhere except pinned open on the notebook route above 1280 px. | P1 |

### 5.9 Admin & observability

| ID | Requirement | Priority |
|---|---|---|
| REQ-48 | Users, Groups, Usage (host CPU/RAM/disk — explicitly not credits), Hosts (node inventory, container list with **role badges** Main/Engine), Settings (Profile, Security & sessions, Home directory, Nkoyo model, Agent skills, API tokens, Git; Workspace-admin: Compute runtime incl. join tokens). | P0 |
| REQ-49 | Empty, loading, and error states for every screen. (The prototype shows only happy paths; production must not.) | P0 |
| REQ-50 | Backup: documented procedure covering the Postgres catalog and lake files; automated scheduled backup. | P1 (docs P0) |

### 5.10 Non-functional requirements

| ID | Requirement | Priority |
|---|---|---|
| NFR-01 | **Privilege boundary:** the Flask app never touches container sockets, never runs as root, never spawns user processes; all privileged operations go through `pebblesd`'s local API. | P0 |
| NFR-02 | `pebblesd` is a single static Rust binary; inter-host API authenticated (mTLS or equivalent). | P0 |
| NFR-03 | Works fully **offline / air-gapped** after image pull (assets bundled — e.g. the US map geometry is baked at build time, never fetched at runtime). GitHub connectivity required only for git features. | P0 |
| NFR-04 | Interactive latency: SQL editor round-trip for a simple query on warm engine < 1 s excluding query time; UI route changes < 200 ms. | P1 |
| NFR-05 | Scale target for v1: 25 concurrent users, 10 engines, 5 hosts, single main. | P1 |
| NFR-06 | Design system per spec §6: Monokai dual theme via CSS custom properties, pink `#F92672` accent, IBM Plex Sans/Mono + Cascadia wordmark, collapsible sidebar with reserved-slot pink-dot active marker. No hard-coded colours in components. | P0 |
| NFR-07 | Known layout landmines respected: no `min-height:100%` inside scrolling flex columns; no `aspect-ratio` in nested auto-row grids; boot-sentinel route restore (not timer-based); versioned route storage key. | P0 |
| NFR-08 | Main-host failure = degraded-but-alive: existing engine sessions keep running; nothing new starts; engines reconnect automatically when the main returns. | P1 |

## 6. Release phasing

**Phase 0 — Foundation (internal). ✅ Complete.**
Unified image; role at setup; `pebblesd` + Flask skeleton with the privilege boundary;
UNIX identity provisioning; single-container install serving one shared engine; SQL
editor against a DuckLake catalog.
*Exit: Ade installs one container and Maya runs a query, each as themselves — encoded
as `scripts/smoke/install-to-first-query.sh`, green on Docker, rootful Podman, and Incus.*

**Phase 1 — MVP (all P0). ✅ Complete.**
Engine registration with single-use tokens; access assignment; shared + dedicated
sessions with draining; notebooks (Python/SQL); dashboards; jobs on hidden Airflow; git
clone/commit/push with Source-control panel; full admin screens; empty/error states.
*Exit: the four personas complete their §4 needs without touching a terminal (except Ade's install).*

**Phase 2 — v1.0 (P1). ✅ Complete — awaiting the v1.0.0 tag.**
Nkoyo + Auto ETL; R kernel; repo-ref workflow tasks; pending-approval registration;
SFTP/Files parity; health-restart loops; backups; upgrade path; NFR-04/05/08 — plus
NFR-02's cluster TLS, Postgres-over-TCP for remote catalogs, and true progressive
result streaming (REQ-31). The UI is the React workbench (all 21 prototype routes);
the CI matrix proves every runtime × topology cell including Incus main+engine.

**Phase 3 — fast-follow (P2 / deferred).**
Automatic engine placement; dedicated-contention notifications beyond the basic wait
alert; pooled read-only dashboard engine; external sharing; multi-host lake storage
first-class design; HA investigation.

## 7. Success metrics

| Metric | Target |
|---|---|
| Time from `docker run` to first successful query (single box) | < 60 min, no docs beyond the setup wizard |
| Time to register an additional engine | < 5 min |
| Share of user-visible permission checks handled purely by UNIX/filesystem | 100% (no second ACL system) |
| Dedicated-session requests resolved by draining without admin intervention | > 95% |
| Job tasks executing under the owning user's uid | 100% |
| Nkoyo/Auto ETL actions executed without explicit user approval | 0 |
| External network calls at runtime (excluding user-initiated git) | 0 |

## 8. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Fat unified image (Airflow + kernels + miniforge scientific stack) slows pulls and updates | Adoption friction | Miniforge stack in one early, cached image layer; budgets sized for the bundled REQ-52 stack and hard-enforced per PR; split a `pebbles-base` image if pull times hurt |
| Uid/gid drift across hosts corrupts the permission model | Data exposure | Main as sole source of truth; registration-time audit; refuse to register on conflict |
| Shared-engine memory contention despite per-session limits | Bad interactive experience | Hard sum-of-limits admission control (REQ-20); dedicated mode as escape hatch |
| Flask streaming under load (SSE/WS on gunicorn) | Sluggish notebooks | Prototype streaming in Phase 0, not Phase 1; isolate streaming workers |
| Airflow operational weight contradicts "install in an afternoon" | Setup pain | Airflow pre-configured inside the image, zero user-facing config; treat as internal dependency we can swap later |
| Draining state confuses users ("why can't I attach?") | Support load | Explicit Draining row state with holder, reason and ETA; cancellable |
| Local-model quality limits Nkoyo/Auto ETL usefulness | Feature disappoints | Approval-gated design means low confidence degrades to "helpful suggestions", never wrong actions; model choice per function in settings |
| Three runtime backends (Docker/Podman/Incus) triple the integration surface | Regression risk, broken installs | One OCI image with a single build path (Incus consumes a converted artifact); small runtime abstraction in `pebblesd`; CI integration matrix runs the same install-to-first-query script on every runtime per merge (see implementation plan §7) |

## 9. Open questions

Carried from spec v2 §10 (see there for detail): multi-host lake storage architecture
(NFS vs. object storage); backup/upgrade specifics beyond REQ-09/50; main-failure UX
polish; external dashboard sharing. R packaging is resolved (REQ-51/52: in-image via
miniforge). None block Phase 0.

## 10. Appendix — screen inventory

21 routes as built in the v15 prototype, plus deltas (Register engine flow, revised
engine states incl. Draining, Sessions panel, Source-control rail panel, Git settings,
join-token admin). Full route table and deltas: spec v2 §5.
