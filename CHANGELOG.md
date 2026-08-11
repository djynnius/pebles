# Changelog

All notable changes to Pebbles are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions will follow
[Semantic Versioning](https://semver.org/) once releases begin.

## [Unreleased]

### Added
- **M2.3 — Nkoyo agency (REQ-44/45)**: Nkoyo can now *act*, and does so bounded by
  the user. The agentic loop drives the planner model with tools; **every tool
  call executes through the invoking user's own engine session**, so Nkoyo can
  never see or touch anything the user can't — REQ-45 is structural, not a check.
  Tools are graded always-on / ask-first / blocked (read-only queries, file
  reads, and catalog listing run automatically; writes and mutating SQL need
  the user's per-turn approval; anything blocked never runs), with a read-only
  SQL guard on the auto query tool. Folder-based skills (`~/.pebbles/skills`,
  `/opt/pebbles/skills`) load their `SKILL.md` into the system prompt (REQ-44).
  The chat page gained per-turn approval checkboxes and shows which tools ran.
  Auto ETL (REQ-46) builds on this next.

### Changed
- **CI builds the integration image once and every cell pulls it** (plan §7):
  the Airflow/science image is too heavy to rebuild in each of five matrix
  cells. A single job now builds and pushes a run-scoped tag to GHCR; docker,
  podman, and incus cells pull it. `cancel-in-progress` prevents run pileups.
- **M2.2 — Nkoyo foundation (REQ-43)**: the assistant arrives, strictly on local
  models. Ollama endpoints are configured under Settings → Nkoyo and
  auto-detected across the fleet (the main's host plus every registered
  engine's host on :11434), with separate model choices for planning, code/SQL,
  and embeddings and a max-steps cap. New Nkoyo chat page (conversation kept in
  the session) with the accent-ring avatar; a clean, guidance-bearing 503 when
  no endpoint is configured — air-gapped installs degrade gracefully. Endpoints
  `GET/POST /nkoyo/config`, `POST /nkoyo/rescan`, `POST /nkoyo/chat`. The
  agentic tool loop (tools through the user's own session, graded permissions,
  REQ-44/45) and Auto ETL (REQ-46) build on this next.
- **MIT license**: `LICENSE` at the repo root, declared in every Rust crate and
  the Python package. Bundled third-party components (DuckDB, Airflow, Postgres,
  the miniforge Python/R stack, …) are invoked as separate processes and keep
  their own licenses; a harvested third-party notices manifest is planned for
  the release pipeline.
- **Phase 2 — SFTP & Files parity (REQ-15/32)**: OpenSSH now runs under pebblesd
  supervision on both roles, PAM/shadow-authenticated — the same password that
  signs into the web UI logs into SFTP, and files dropped there land in the
  user's home. Host keys live in the config volume (stable across restarts and
  upgrades). New **Files** screen: browse your home with breadcrumbs, upload
  (multi-file), download, create folders, and delete — every operation runs
  through your own session as your uid, with path-traversal refused server-side.
  The kernel gained `browse`/`upload`/`mkdir`/`delete`/`rename` ops (upload
  decodes base64 with a dependency-free decoder). Smoke proves sshd
  authenticates maya's UNIX password to uid 70000 and the Files ops land
  correctly-owned files in her home.

### Fixed
- **Jobs now run on Airflow 2.10 instead of 3.3.** Airflow 3's Task Execution API
  (task supervisor → HTTP `/execution/…` with a JWT handshake) kept returning 404
  in the supervised single-node setup despite correct URLs, `--apps all`, and
  shared secrets. Airflow is a hidden, swappable internal dependency (spec risk
  table); 2.10's LocalExecutor runs tasks as direct subprocesses against the
  metadata DB — no execution API, no JWT, and only ONE supervised service (the
  scheduler) instead of three. Deletes the entire failure class.
- Hard timeouts so a hung Airflow CLI can't wedge a request handler or CI: the
  trigger path runs the CLI under a 60 s cap and every smoke curl carries
  `--max-time`. The api-server now serves all apps (`--apps all`) so task
  supervisors reach the execution API.
- **M1.8 — admin completeness**: the operator's cockpit. **Usage** page: host
  CPU load, memory, and per-mount disk — explicitly resources, never credits
  (REQ-48). **Hosts** page: this container with its Main badge plus every
  engine with role, state, and a Remove action — deregistering invalidates the
  engine's credentials (REQ-08). **Settings → Compute runtime**: join tokens
  minted in the UI (plaintext shown exactly once), listed and revocable
  (REQ-05), and the **pending-approval flow** (REQ-06): an engine booted
  without a token knocks every 10 s, shows up as pending, and completes
  registration the moment an admin approves — reject sends it away. Admin
  pages now surface fetch errors instead of silently emptying (REQ-49
  groundwork). The duo smoke proves the pending → approve → registered →
  deregistered lifecycle end to end.
- **M1.7 — git**: first-class git, entirely under the user's own identity. The
  kernel gained a whitelisted `git` op (porcelain subcommands only) that runs
  as the session user with their credentials — `~/.ssh` keys or an HTTPS PAT
  in `~/.git-credentials` at 0600; Pebbles never holds a shared GitHub
  credential (REQ-33). New **Repos** pages: clone into `~/repos` (REQ-32), and
  a per-repo source-control view with branch + ahead/behind, changed files
  with click-to-stage/unstage, diff and log views, and Commit / Commit & push /
  Pull (REQ-35 as a page; the workbench rail panel lands with the shell
  unification). **Git settings** (REQ-34): commit identity, ed25519 keypair
  generation with the copyable public key, PAT storage. Smoke proves the whole
  loop offline: init a bare origin, clone, write, stage, commit, push, and
  read the commit back from origin — all as maya, repo owned by her uid.
- **M1.6 — jobs on hidden Airflow**: workflows are real pipelines now. Airflow
  3.x lives in its own venv, supervised by pebblesd on the main (api-server on
  localhost, scheduler, dag-processor) — completely invisible; the Jobs UI is
  the only face (REQ-38). Pebbles workflows (JSON: name, cron-or-manual
  schedule, tasks of type sql/python/r/shell/notebook with engine, catalog,
  session mode, retries, dependencies) **compile to generated DAG files**, and
  every task executes through a pebblesd session **as the workflow owner** on
  the chosen engine (REQ-41) via a shipped stdlib-only operator — the Airflow
  worker never touches user files or code itself. Run history and per-task
  logs come from Airflow's metadata DB and log files (REQ-42), surfaced in the
  new Jobs page (build, save, run now, run list, task detail with logs). The
  kernel gained a `shell` op. Smoke proves the whole path: a saved workflow
  triggers, succeeds, and its artifact lands in the owner's home owned by
  their uid. Deferred honestly: drag-and-drop canvas (list builder for now),
  on-file triggers, overlap policy, catch-up toggle, and failure notifications
  (REQ-39/40 remainder → M1.8/Phase 2).
- **M1.5 — dashboards**: a gallery plus a rearrangeable single-dashboard view
  (REQ-28). Dashboards are JSON files in `~/dashboards` — same identity story
  as notebooks — holding tiles of saved SQL that run through the viewer's own
  session against a chosen catalog, streaming over SSE. Three tile kinds:
  table, stat (big single value), and bars (dependency-free CSS bar chart —
  nothing fetched at runtime, NFR-03). Edit mode adds, removes, and reorders
  tiles; sharing beyond the owner arrives with catalog grants doing the data
  side today and dashboard-level sharing tracked for Phase 2.
- **Miniforge runtimes + bundled scientific stack (REQ-51/52) and R cells**:
  Python, R and Jupyter now ship in-image via miniforge (conda-forge) at
  `/opt/conda`, with the owner-specified package set out of the box — Python:
  numpy, pandas, scipy, statsmodels, scikit-learn, matplotlib, seaborn,
  plotnine, geopandas, duckdb, polars, networkx, pmdarima, xgboost, openpyxl;
  R: r-essentials, r-gtsummary, r-arrow, r-duckdb, r-tidymodels, r-survey.
  The bundled set is a floor, not a wall: users install more with
  `pip install --user` or personal conda envs, no admin needed. Session kernels
  run on the conda runtimes, and notebooks gained **R cells** backed by a
  persistent per-session R executor (state across cells, like Python). PRD
  updated (REQ-10 resolved in-image; new REQ-51/52); image size budget raised
  to the `science` tier deliberately in this change. Smoke now proves the
  bundled packages import and R answers, as the session user.
- **M1.4 — notebooks & workbench v1**: notebooks arrive. A persistent Python
  executor runs inside each session (spawned by the kernel, so it inherits the
  session user's uid and home) — cell state carries across executions like a
  real notebook, and the last expression echoes notebook-style. Notebooks are
  plain JSON files in `~/notebooks` (yours alone, SFTP-visible, ready for git —
  REQ-32's story) with SQL and Python cells; the editor is the first cut of the
  workbench shell: 46 px icon rail, folding panel, document tab bar, and the
  <1280 px overlay-with-scrim rule (REQ-29/30). Cell output streams over SSE
  (REQ-31) — SQL cells render a results grid, Python cells stdout/stderr. The
  kernel protocol gained `python` and `list` ops, and `write` now creates parent
  directories. Smoke proves python-as-the-user with persistent state.
- **M1.3 — dedicated sessions & draining**: the REQ-19 state machine. A dedicated
  request on a busy engine returns **202 with a reservation** — never refusal,
  never preemption; the engine enters *draining* (no new shared sessions;
  running work finishes naturally) and the dedicated session starts the moment
  the engine empties. Reservations are visible (`GET /sessions/reservation`,
  engine states show `draining (reserved for <user>)`), cancellable by requester
  or admin (also from the Engines page), limited to one per engine, and flag
  `notified` once the configured wait elapses (`PEBBLES_DRAIN_NOTIFY_SECS`,
  default 15 min). Dedicated sessions auto-release on idle like all sessions;
  `PEBBLES_ALLOW_DEDICATED=false` disables dedicated per engine (REQ-18). The
  engine list now carries the fuller REQ-23 state model (available / in use /
  draining / dedicated-to / stopped) with live session counts, sourced from each
  engine's own status endpoint. The main+engine CI cell now also runs under
  rootful Podman.
- **M1.2 — groups & access**: team groups are real UNIX groups with gids from the
  same reserved pool, persisted in the config volume and replicated to engines
  with users and memberships (REQ-13/14). Catalog grants are enforced by the
  platform's own primitives: setgid group permissions on the data root plus
  Postgres role grants (schema/table privileges, default privileges for future
  tables, and role membership for each member — new members are wired on join).
  Engine access (REQ-07) is `everyone` or `group:<name>`, enforced at session
  open. The session broker now runs `initgroups` before `setuid` — without it,
  supplementary groups (and therefore every grant) would be invisible to session
  processes. New endpoints: `/groups` CRUD + members, `/catalogs/{name}/grants`,
  `/engines/{name}/access`; new Users and Groups admin pages in the web UI. The
  smoke tests prove deny-before-grant / allow-after-grant on the lake and the
  403-then-allowed flow for group-gated engines.

### Fixed
- pebblesd now establishes a default `PATH` when it boots as a system-container
  init (Incus starts init with an empty environment; every PATH-relative spawn
  failed with ENOENT — Docker/Podman inject a PATH, which is why only the Incus
  cell broke).
- **M1.1 — engine registration (Phase 1 begins)**: the fleet is real. The main
  mints **single-use join tokens** (24 h expiry, hashed at rest, revocable —
  REQ-05) over the privileged socket; a new cluster TCP API (bearer-authenticated;
  TLS scheduled before v1.0) accepts engine registrations. Registration audits
  the engine's uids and **refuses on drift** (REQ-11), requires lake-path
  reachability (REQ-26), and replies with a per-engine secret plus the identity
  snapshot; account creation replicates to every engine (REQ-14). Engine-role
  containers register at boot (sticky, with retry) and serve sessions over the
  cluster API; the main proxies open/exec/close to named engines, so
  `POST /sessions {"engine": "worker-1"}` runs the kernel on that engine under
  the user's uid. New Engines page in the web UI, and a main+engine CI cell
  proving token single-use, replication, and cross-container session identity
  end to end.
- **M0.6 — three runtimes + upgrade scaffold (Phase 0 exit)**: the CI integration
  matrix now runs the full install-to-first-query acceptance script on **Docker,
  rootful Podman, and Incus** — the Incus cell converts the OCI image to a
  system-container image and runs it unprivileged with the ADR-001 idmap. As the
  init of a system container, pebblesd now configures networking itself (loopback
  + busybox DHCP on eth0), standing down when Docker/Podman already did it. The
  docker/podman cells run on an **internal network with zero egress** — the whole
  product path works air-gapped (NFR-03). Identity now survives upgrades:
  accounts snapshot into the config volume and restore on boot (REQ-09/11).
  A schema-version stamp plus a **mandatory pre-migration `pg_dumpall` backup**
  form the migration scaffold, and a nightly workflow proves the whole upgrade
  path (old edge → current main on the same volumes, forced schema bump, data
  and accounts intact) plus an arm64 smoke cell.
- **M0.5 — DuckLake + SQL editor + SSE**: the lake is real. The image vendors the
  DuckDB CLI (pinned) with the `ducklake` and `postgres` extensions installed at
  build time — sessions load them from a shared read-only directory, never from
  the network (NFR-03). `POST /catalogs` provisions a DuckLake catalog: a
  `ducklake_<name>` Postgres database owned by the catalog owner (peer-auth role
  created on demand) plus a Parquet data root under the lake directory. The
  kernel's new `sql` op attaches the catalog as the session user and executes
  through the CLI in JSON mode with the session's memory limit applied. The web
  tier gains a Lake catalogs page (form + live `CREATE CATALOG` SQL, REQ-25) and
  a SQL editor whose results stream over Server-Sent Events (REQ-31); gunicorn
  moved to threaded workers so SSE connections don't starve the pool. The smoke
  test now runs the actual install-to-first-query moment: Maya creates a catalog,
  loads a CSV, queries it, time-travels to the pre-insert snapshot, and receives
  results over SSE.
- **M0.4 — sessions as the user**: the session broker forks one kernel process per
  attached user with setuid/setgid to that user, cwd their home, and a handshake
  tripwire — the kernel reports the uid it actually runs as and the broker kills
  the session on mismatch. Memory admission (sum-of-limits, REQ-20) now gates real
  processes and releases on close; idle sessions reap after a timeout. New
  privileged endpoints: `POST/GET /sessions`, `POST /sessions/{id}/exec`,
  `DELETE /sessions/{id}`; `PEBBLES_SERVE_SESSIONS=false` turns serving off
  (REQ-04 toggle). `sql-runner` speaks a JSON-lines protocol (ping/read/write —
  the seam DuckDB drops into at M0.5). The smoke test proves the load-bearing
  claim: two users' sessions run under distinct uids (via `/proc`), user A cannot
  read user B's files through her session, and an over-budget session gets a
  clean 409.
- **M0.3 — UNIX identity**: creating a Pebbles user now provisions a real host
  account — uid from the reserved range with a personal primary group (uid == gid),
  a private `0700` home, and an SHA-512-crypt password in `/etc/shadow` (the same
  credential SSH uses). New pebblesd endpoints on the privileged socket:
  `POST/GET /users` and `POST /auth/login` (shadow-verified). The web UI gained a
  Monokai login page; the shell is session-gated and shows the signed-in identity.
  `docs/adr/ADR-001-uid-range.md` fixes the reserved uid/gid range at **70000–74999**
  (moved off the earlier 60000–64999 working proposal because Debian globally
  reserves that block and the image is Debian). The smoke test now runs the full
  Ade-creates-maya / maya-signs-in path and asserts host state matches the API.
- **M0.2 — pebblesd boots the box**: pebblesd is now a real PID-1 supervisor — it
  starts and supervises Postgres (unix-socket only, data in the config volume) and
  gunicorn (as the unprivileged `pebbles-web` user, never root) on the `main` role,
  with restart backoff and graceful SIGTERM fan-out. Interactive first boots get a
  TTY setup wizard for the role question. The web tier now owns port 8080; Flask's
  `/healthz` proxies pebblesd over the group-gated unix socket (`pebbles` group,
  mode 0660) — the NFR-01 privilege boundary exercised end to end. The smoke test
  asserts the M0.2 exit criterion: `docker run -e PEBBLES_ROLE=main` serves the
  Flask shell and the role survives restarts.
- `pebbles-implementation-plan.md` — stack decisions, repository layout,
  container-runtime strategy (Docker / rootful Podman / LXC via Incus), image
  engineering, full CI/CD design, and the Phase 0 milestone plan (M0.1–M0.6).
- Repository scaffold (milestone M0.1): Rust workspace (`pebblesd`, `pebbles-api`,
  `pebbles-runtime`, `pebbles-identity`, `pebbles-session`, `xtask`, `kernels/sql-runner`),
  Flask web skeleton (`web/`), multi-stage `image/Containerfile`, OCI→Incus conversion
  script, deploy examples for all three runtimes, install-to-first-query smoke script,
  and GitHub Actions workflows (`ci.yml`, `image.yml`, `integration.yml`).
- `README.md` project overview and document map.
- `CLAUDE.md` guidance for AI-assisted development.
- Product documents: PRD v1.0, design spec v2, v15 interactive prototype.

### Changed
- **Scope:** Podman added as a third supported runtime alongside Docker and LXC
  (REQ-02); rootful-only in v1. The LXC backend now explicitly targets **Incus**.
- PRD: new risk row for the three-runtime integration surface; companion-documents
  list gains the implementation plan.
- Spec v2: runtime mentions updated (§1, §2, §3) with Podman marked **[new]**.
