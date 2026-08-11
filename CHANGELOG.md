# Changelog

All notable changes to Pebbles are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions will follow
[Semantic Versioning](https://semver.org/) once releases begin.

## [Unreleased]

### Added
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
