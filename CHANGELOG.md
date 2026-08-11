# Changelog

All notable changes to Pebbles are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions will follow
[Semantic Versioning](https://semver.org/) once releases begin.

## [Unreleased]

### Added
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
