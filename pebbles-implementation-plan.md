# Pebbles — implementation plan

**Version:** 1.0 · **Date:** August 2026 · **Status:** Active
**Companion documents:** `pebbles-prd.md` (requirements, REQ/NFR IDs), `pebbles-spec-v2.md`
(UX & architecture), `ui_ux.html` (visual design).

This document is the source of truth for **how Pebbles gets built**: technology stack,
repository layout, container-runtime strategy, image engineering, CI/CD, and the Phase 0
milestone plan. Where the spec marks something **[proposed]** or **[open]**, this document
records the working resolution; contested calls are listed in §10 for owner sign-off.

---

## 1. Principles

1. **One image, three runtimes.** The single Pebbles OCI image (REQ-01) runs under
   **Docker, Podman, and LXC (via Incus)**. LXC never gets its own build — it consumes a
   CI-converted artifact of the same image. "Upgrade = pull new image" (REQ-09) therefore
   means the same thing on every runtime.
2. **CI does the heavy lifting.** Local dev is `cargo` + `flask` against a scratch config
   dir — no image builds on laptops. CI builds multi-arch images, converts the Incus
   artifact, runs the cross-runtime integration matrix, enforces the image-size budget
   (a named PRD risk), and tests the upgrade path.
3. **Build once, convert once, test the same digest everywhere, promote — never rebuild —
   at release.** What ships is byte-identical to what passed the matrix.
4. **The privilege boundary is mechanical, not disciplinary.** The Flask tier's only path
   to privileged operations is a client *generated* from `pebblesd`'s API schema (NFR-01).

## 2. Stack decisions

| Layer | Choice | Rationale |
|---|---|---|
| Daemon | **Rust**, static musl binary (NFR-02): `tokio` + `axum` (REST/JSON over unix socket), `utoipa` (OpenAPI), `bollard` (Docker/Podman), `git2`-free — git shells out (see §2.1) | Single-binary supervisor; curl-debuggable API; no protoc in the Python tier; SSE passthrough trivial. gRPC buys nothing at 25-user scale (NFR-05). |
| Web | **Python 3.12 + Flask** under gunicorn; SSE routes on a dedicated worker class; `uv`-managed | Spec-mandated; deliberately thin (NFR-01). |
| Engine | **DuckDB 1.5.x** with **DuckLake v1.0** (production since 2026-04); catalog in Postgres; extensions **vendored into the image** — runtime `INSTALL` is forbidden (NFR-03) | Spec-mandated; DuckLake v1.0 carries backward-compat guarantees, which REQ-09 leans on. |
| Jobs (Phase 1) | **Airflow 3.x** | Airflow 3's Task Execution API model (tasks never touch the metadata DB; they call an API) matches our design exactly: operators call `pebblesd` — "run X on engine Y as user Z" (REQ-41). |
| Catalog/metadata DB | **Postgres 16**, bundled in the image, active on `main` role only | Spec-mandated; also Airflow's metadata DB in Phase 1. |
| Container mgmt | `bollard` for Docker **and** rootful Podman (docker-compat socket); thin hand-rolled REST client for **Incus** | See §4. |

### 2.1 Resolutions of spec [proposed]/[open] items

| Spec item | Resolution | Why |
|---|---|---|
| pebblesd API transport [proposed] | REST/JSON over unix socket; mTLS TCP between hosts (Phase 1) | See stack table. |
| In-container init (unstated) | **`pebblesd` is PID 1** — no s6/supervisord; symlinked `/sbin/init` | It must supervise processes anyway ("supervisor mode", REQ-22). One init contract for Docker, Podman, *and* LXC — Incus system containers need an init, and this is it. |
| Git via git2-rs [proposed] | **Shell out to `git`** as the requesting user (fork + setuid) | `~/.ssh/config`, agents, credential helpers, PATs all work natively; libgit2 reimplements each badly. |
| R packaging [open] | **Optional image layer** (`pebbles:<ver>-r` tag), not in base | Directly serves the fat-image risk; R is P1. |
| Multi-host lake storage [open] | Deferred; Phase 0 is single-box local path. Reachability check (REQ-26) lands with engine registration in Phase 1. | PRD: doesn't block Phase 0. |
| LXD vs Incus (new) | **Incus** | Community-governed (linuxcontainers.org), Apache-2.0, in Debian/Ubuntu archives, current 7.0 LTS. LXD API compat is incidental, untested, unclaimed. All "LXC" surfaces say Incus. |

## 3. Identity model — the load-bearing constants

- **Reserved uid/gid range for Pebbles users: 70000–74999** (5000 accounts; NFR-05 needs
  25). Decided in `docs/adr/ADR-001-uid-range.md` — the earlier 60000–64999 proposal sat
  inside Debian's globally-reserved block, and our image is Debian. Allocated by the main,
  stamped into the config volume, audited at engine registration; registration **refuses
  on conflict** (PRD uid-drift risk). Treat the range like a wire-protocol constant;
  changing it post-v1 means chowning every home and lake file on every host.
- **Rootful Podman only in v1.** Rootless remaps uids through the invoking user's subuid
  range, so uid 60001 in-container ≠ 60001 on the host — bind-mounted homes and lake files
  get garbage owners and REQ-11..15 silently break. `pebblesd` detects a rootless socket at
  setup and **fails loudly** with a doc link. Rootless support would be a second identity
  model; post-v1 at the earliest.
- **Incus: unprivileged containers with an explicit 1:1 idmap** of the reserved range
  (`raw.idmap: "both 70000-74999 70000-74999"`; host root's subuid must delegate the range —
  deploy docs and the CI setup action handle it). Privileged containers are the documented
  fallback for hosts without subuid delegation.
- **Engine container capabilities:** `pebblesd` runs as root in-container and forks session
  processes with setuid/setgid (REQ-12/16). Needed: `SETUID`, `SETGID`, `CHOWN`, `FOWNER`,
  `DAC_OVERRIDE`, `KILL` (+ `AUDIT_WRITE` on main for sshd/PAM). Docker/Podman defaults
  already include these — policy is "default caps, **no `--privileged`**, drop
  `NET_RAW`/`MKNOD`", stated explicitly in `deploy/` so hardened hosts don't silently break
  sessions. `no-new-privileges` must stay **off** for engine containers (it blocks setuid
  transitions) — documented, because it will surprise people.

## 4. Container runtime strategy

`pebblesd` touches a runtime in exactly two places: **main-managed engines** (create/
start/stop/restart on the main's host — REQ-04/22) and **inspection** for the Hosts screen.
Admin-provisioned engines on other hosts are booted by the admin's tooling and merely
*register*. So the abstraction stays small:

```rust
#[async_trait]
pub trait ContainerRuntime {
    async fn launch_engine(&self, spec: &EngineSpec) -> Result<ContainerRef>;
    async fn stop(&self, c: &ContainerRef, timeout: Duration) -> Result<()>;
    async fn remove(&self, c: &ContainerRef) -> Result<()>;
    async fn inspect(&self, c: &ContainerRef) -> Result<ContainerState>;
    async fn list_pebbles_containers(&self) -> Result<Vec<ContainerInfo>>;
    fn capabilities(&self) -> RuntimeCaps; // gpu, idmap support, …
}
```

No `exec`, no log-follow, no build — sessions are brokered by the `pebblesd` *inside* each
engine over its API, never via `docker exec`.

| Backend | Driver | Notes |
|---|---|---|
| Docker | `bollard` over `/var/run/docker.sock` | Mature, first-class. |
| Podman (rootful) | **Same `bollard` driver** over `/run/podman/podman.sock` (docker-compat API; Podman 5.x/6.x) | No libpod driver in v1. Differences handled by a small quirks table keyed off `GET /_ping` headers. Socket must be enabled (`systemctl enable --now podman.socket`). |
| LXC (Incus) | Thin hand-rolled client over `/var/lib/incus/unix.socket` (~8 endpoints: `/1.0/instances`, `/1.0/operations/…`) | No maintained Rust crate; the needed surface is tiny, stable JSON + async-operation polling wrapped once. |

Selection: per-host config (`runtime = docker | podman | incus`), auto-detected at first
boot by probing sockets in that order.

## 5. Repository layout

```
pebles/
├── Cargo.toml                  # workspace: crates/* + kernels/sql-runner
├── rust-toolchain.toml
├── crates/
│   ├── pebblesd/               # binary: PID-1 supervisor, role bootstrap, unix-socket REST API
│   ├── pebbles-api/            # request/response types; utoipa → OpenAPI → generated Flask client
│   ├── pebbles-runtime/        # ContainerRuntime trait + docker/podman/incus drivers
│   ├── pebbles-identity/       # uid allocator (70000–74999, ADR-001), useradd wrappers, shadow auth
│   ├── pebbles-session/        # session broker: spawn-as-uid, memory admission (REQ-20), idle timers
│   └── xtask/                  # cargo xtask: api-schema export, size report
├── web/                        # Flask app; pebblesd_client.py is generated, talks ONLY to the socket
├── kernels/
│   └── sql-runner/             # runs DuckDB+DuckLake under the session uid; line protocol to pebblesd
├── image/
│   ├── Containerfile           # the one image; multi-stage; optional -r layer target
│   ├── lxc/oci-to-incus.sh     # skopeo → umoci → rootfs.tar.xz + metadata.tar.xz
│   └── budgets.json            # size budgets, enforced in CI
├── deploy/
│   ├── docker/                 # compose: single-box, main+engine
│   ├── podman/                 # rootful quadlet units
│   └── incus/                  # profile (raw.idmap, caps), cloud-init role examples
├── scripts/
│   ├── smoke/install-to-first-query.sh   # THE acceptance script; same file in every CI cell
│   ├── ci/                     # size gate, helpers
│   └── dev/run.sh              # native dev loop; no image build needed locally
├── docs/                       # HOWTO source; backup/upgrade procedure (REQ-50 docs are P0)
└── .github/workflows/          # ci, image, integration, nightly, release
```

Why it's shaped this way:
- **`pebbles-api` as a crate, not an afterthought:** the NFR-01 boundary only holds if the
  Flask client is mechanically derived from the daemon's types. An `api-drift` CI job
  regenerates the OpenAPI schema + Python client and fails if the tree is dirty.
- **`kernels/` outside `crates/` and `web/`:** launchers run *as end users* inside engines;
  the separation keeps the privilege story auditable — nothing in `web/` executes on an
  engine, nothing in `kernels/` is reachable from the web tier.
- **One `Containerfile`:** Podman and Docker both build it; Incus consumes the conversion.

## 6. Image engineering

Multi-stage `Containerfile`:

1. `rust-builder` — static musl `pebblesd` + `sql-runner` (NFR-02).
2. `web-builder` — `uv sync` into `/opt/pebbles/web` venv.
3. Runtime — `python:3.12-slim-bookworm` base + `git`, `openssh-server` (SFTP, REQ-15),
   Postgres client/server, DuckDB + vendored DuckLake extension. `ENTRYPOINT ["pebblesd"]`,
   symlinked `/sbin/init`. Config volume `/var/lib/pebbles` (role stickiness, REQ-03).
4. Optional `-r` target adds the R kernel layer (Phase 2).

**Python environment isolation:** three separate uv-managed venvs — `/opt/pebbles/web`,
`/opt/pebbles/airflow` (Phase 1), and the kernel env. Airflow's dependency tree never
fights Flask's; nothing outside the airflow venv may import from it (keeps the "internal
dependency we can swap later" stance honest).

**Size budgets** (`image/budgets.json`, hard CI gate): Phase 0 base **1.2 GB compressed**;
raised *deliberately in the PR that adds Airflow* to a v1 ceiling of **2.0 GB compressed /
4.5 GB uncompressed**. Raising the budget requires editing the JSON in the same diff, where
reviewers see it. PRs get a size delta vs `main` in the job summary — the fat-image risk is
managed per-PR, not discovered per-release.

**Incus artifact:** `skopeo copy` the built OCI image → `umoci unpack` → rootfs tarball +
`metadata.tar.xz` → `incus image import`-able pair, one per arch, published as release
assets. (Incus ≥ 6.3 can also run OCI images directly as *application* containers; we ship
the converted *system-container* image because pebblesd-as-init wants a real init contract,
but the OCI path is a documented quick-trial option.)

## 7. CI/CD design (GitHub Actions)

### Workflow inventory

| Workflow | PR | main | nightly | tag `v*` |
|---|---|---|---|---|
| `ci.yml` — lint/test, path-filtered | ✅ | ✅ | — | — |
| `image.yml` — build + size gate | amd64, no push | multi-arch → GHCR `:edge` | — | (promoted, not rebuilt) |
| `integration.yml` — runtime matrix | docker single-box (image-affecting paths) | full matrix | full + arm64 | full, on candidate |
| `nightly.yml` — upgrade path, size trend | — | — | ✅ | — |
| `release.yml` — promote, Incus artifacts, changelog | — | — | — | ✅ |

### `ci.yml` (PR + main) — fast, cached, path-filtered

```
changes ──┬─ rust:    fmt → clippy -D warnings → test        (Swatinem/rust-cache)
          ├─ python:  uv sync → ruff → pytest                (uv cache; web/)
          ├─ api-drift: regen OpenAPI + client → fail if git-dirty   ← guards NFR-01
          └─ docs:    markdown lint
```

Docs-only PRs finish in under a minute; Rust and Python run in parallel.

### `image.yml`

- **PR** (when `image/`, `crates/`, `web/`, `kernels/` change): amd64 build, no push →
  size gate → docker single-box smoke.
- **main:** native amd64 (`ubuntu-24.04`) + arm64 (`ubuntu-24.04-arm`) builds — **no QEMU**
  (Rust under emulation is the classic multi-hour trap) → `imagetools` manifest merge →
  GHCR `:edge` by digest → size gate → trigger conversion job (Incus tarballs as artifacts).

### `integration.yml` — the matrix

`runtime ∈ {docker, podman-rootful, incus} × topology ∈ {single-box, main+engine}` = 6
cells (arm64 cells nightly). Podman is preinstalled on `ubuntu-24.04` runners; Incus
installs in-job (archive or Zabbly repo) via a `setup-incus` composite action that also
delegates subuids 70000–74999 and imports the converted tarball. Every cell runs the
**same** `scripts/smoke/install-to-first-query.sh`:

1. Boot main from the exact digest built upstream (`PEBBLES_ROLE=main`, fresh config
   volume); for main+engine, boot a second container with a token minted via the API.
2. **Ade path:** create user `maya` via API; assert uid ∈ 70000+ and `/home/maya`
   ownership *on the host*.
3. **Maya path:** authenticate as maya; open a session; `CREATE CATALOG` + query DuckLake;
   assert results, session-process uid == maya's uid, and a file maya writes is hers on
   the host mount.
4. Assert **zero outbound network calls** during 2–3 (NFR-03) via deny-all egress.

That script *is* the Phase 0 exit criterion, encoded and reused everywhere.

### `nightly.yml`

- Full matrix incl. arm64.
- **Upgrade-path test (REQ-09):** install latest published release → seed users + a
  catalog *with snapshots* → restart on `:edge` with the same config volume → assert
  pre-migration backup exists, migrations ran, the old query still answers, uids unchanged.
- Size-trend report; alert at 90% of budget.

### `release.yml` (tag `v*`)

1. **Promote** the last matrix-passing digest from main — retag, never rebuild.
2. Regenerate Incus tarballs from that digest (both arches) + sha256sums.
3. Re-run the full matrix + upgrade test (previous release → candidate).
4. Changelog from `CHANGELOG.md` → GitHub Release with image digests,
   `pebbles-incus-{amd64,arm64}.tar.xz`, checksums, upgrade notes.

## 8. Local development

`scripts/dev/run.sh` runs `pebblesd` (cargo) + Flask natively against a scratch config
dir — no container needed for the inner loop. The image is a CI product; building it
locally (`docker build -f image/Containerfile .`) is supported but never required.

## 9. Phase 0 milestones

Target exit (PRD §6): *"Ade installs one container and Maya runs a query, each as
themselves."* Airflow is excluded from the Phase 0 image (jobs are Phase 1); budgets
already reserve its headroom.

| # | Milestone | Exit criteria |
|---|---|---|
| M0.1 ✅ | **Scaffold + PR CI** | Workspace compiles; Flask hello; `ci.yml` green; path filters work; a docs-only PR runs <1 min. |
| M0.2 ✅ | **pebblesd boots the box** | PID-1 supervisor; role via env + minimal TTY wizard, sticky in config volume (REQ-03); unix-socket API (health/version); supervises Postgres + gunicorn on `main`. `docker run -e PEBBLES_ROLE=main` serves the Flask shell; restart preserves role; size gate live. |
| M0.3 ✅ | **UNIX identity** (REQ-11 core) | ADR-001 (uid range) written; create-user API → real account + 0700 home + personal primary group (REQ-13 machinery); shadow-verified login through pebblesd (SHA-512 crypt — PAM can't link into a static musl binary; same shadow entry sshd uses, so REQ-15 holds); Flask login. Host `getent`/`ls -ln` agree with the API. |
| M0.4 ✅ | **Sessions as the user** (REQ-12/16/20 core) | Broker forks `sql-runner` with setuid/setgid, cwd the user's home; per-session `memory_limit` with sum-of-limits admission, released on close; idle reaper; kernel-handshake uid tripwire. Proven in the smoke test: distinct uids via `/proc`, cross-user read refused, over-budget session gets a clean 409. **This was the spec's load-bearing reconciliation.** |
| M0.5 ✅ | **DuckLake + SQL editor + SSE** | DuckDB CLI + ducklake/postgres extensions vendored into the image at build time (NFR-03); catalogs = Postgres db (`ducklake_<name>`, peer-auth owner role) + Parquet root; kernel `sql` op attaches as the session user with the session memory limit; Create Catalog page with live SQL (REQ-25); SQL editor streaming over SSE (REQ-31) on gthread workers. Smoke: Maya creates a catalog, loads a CSV, queries, time-travels the pre-insert snapshot, and gets results over SSE. |
| M0.6 ✅ | **Three runtimes + upgrade scaffold** | 3-cell matrix (docker / rootful podman / incus single-box) green on `install-to-first-query.sh`, with zero-egress internal networks on docker/podman (NFR-03) and the Incus cell running the converted image unprivileged with the ADR-001 idmap; pebblesd-as-init does lo+DHCP in system containers; identity persists/restores across image swaps; schema-version stamp + mandatory pre-migration backup; nightly upgrade-path test (forced bump) + arm64 smoke. The main+engine topology joins the matrix with engine registration in Phase 1. **= Phase 0 exit.** |

Sequencing: M0.1→M0.2 strictly first; M0.3→M0.4→M0.5 is the dependency spine; M0.6's
conversion/matrix work starts in parallel from M0.2 (it only needs a bootable image) —
the runtime matrix must not be left for last.

## 9b. Phase 1 milestones (MVP — all P0)

Target exit (PRD §6): *"the four personas complete their §4 needs without touching a
terminal (except Ade's install)."*

| # | Milestone | Scope / exit criteria |
|---|---|---|
| M1.1 ✅ | **Engine registration** | Join tokens minted/listed/revoked via API (hashed at rest, single-use, 24 h — REQ-05; admin UI lands M1.8); cluster TCP API (bearer auth; TLS pre-v1.0) for registration + engine session serving; uid audit **refuses on conflict**; identity snapshot at registration + push replication on user create (REQ-11/14); lake reachability required (REQ-26); main proxies sessions to named engines (REQ-17 explicit choice); Engines list/page (available/stopped; full REQ-23 model in M1.3). Main+engine docker cell in the CI matrix proves token single-use, replication, and cross-container session identity. |
| M1.2 ✅ | **Groups & access** | Groups CRUD = real UNIX groups (gids from the shared reserved pool) replicated to engines with memberships (REQ-14); catalog grants = setgid data dirs + Postgres role grants incl. default privileges (REQ-13); engine access `everyone`/`group:<name>` enforced at session open (REQ-07); broker initgroups-before-setuid so grants reach session processes; Users/Groups admin pages. Schema-level grants follow with the workbench catalog browser. |
| M1.3 ✅ | **Dedicated sessions & draining** | REQ-19 state machine in the broker: dedicated on a busy engine → 202 reservation + draining (shared opens 409; work finishes naturally); fulfillment on empty; status/cancel endpoints (proxied for remote engines); one reservation per engine; `notified` after the configured wait; `PEBBLES_ALLOW_DEDICATED` per engine (REQ-18); idle auto-release. Engine list carries the REQ-23 state model with live session counts. Duo matrix gained rootful Podman; the incus duo follows once shared-volume devices are wired for system containers. |
| M1.4 | **Workbench shell & notebooks** | The 46 px icon rail + routing document tabs + ≶1280 px overlay/push rule (REQ-29/30); notebook editor with Python + SQL cells; `kernels/python-kernel` under the session identity; live cell output over SSE (REQ-31). |
| M1.5 | **Dashboards** | Gallery + rearrangeable single-dashboard view fed by saved SQL against engines (REQ-28). |
| M1.6 | **Jobs on hidden Airflow** | Airflow 3.x in its own venv (image budget raised deliberately in this PR); workflows compile to DAGs; operators call pebblesd — "run X on engine Y as user Z" (REQ-38/41); drag-and-drop builder, triggers/cadence/test-run (REQ-39/40); run detail with logs (REQ-42). |
| M1.7 | **Git** | Clone into `~/repos` from Files (REQ-32); all git ops as the requesting uid via the `git` CLI (REQ-33); Settings → Git (REQ-34); Source-control rail panel: branch, stage, diff tab, commit/push/pull (REQ-35). |
| M1.8 | **Admin completeness** | Usage (host resources, never credits), Hosts with role badges, Settings per REQ-48; **empty/loading/error states for every screen** (REQ-49); registration-pending approval flow (REQ-06); deregister invalidates credentials (REQ-08). |

Sequencing: M1.1→M1.2→M1.3 is the compute spine and unlocks the matrix topology;
M1.4→M1.5 build on the session APIs; M1.6 depends on M1.1 (engines) and the budget
raise; M1.7 is independent after M1.4's shell; M1.8 closes the phase.

## 10. Risks and decisions needing owner sign-off

1. **Incus over LXD** (§2.1) — named everywhere; LXD compat incidental. *Sign-off needed.*
2. **Rootful-only Podman v1** — rootless is Podman's default posture; we must *detect and
   refuse*, not degrade. Failing to detect rootless is a data-integrity incident, not an
   inconvenience. *Sign-off needed.*
3. **ADR-001: uid/gid range 70000–74999** — decided and written (`docs/adr/`): the
   60000–64999 candidate sat inside Debian's globally-reserved block and our image is
   Debian, so the range moved to unallocated space. Near-irreversible from M0.3 on.
   *Sign-off needed (review the ADR).*
4. **Airflow 3.x weight + venv isolation** — three venvs; budget headroom pre-reserved;
   Airflow pinned to a constraints file. Watch: Airflow 3 requires our operator to use the
   Task SDK model (no DB access) — which is what REQ-41 wanted anyway.
5. **DuckLake maturity vs the upgrade promise** — pin exact DuckDB + extension versions,
   vendor the extension files, snapshot-bearing catalog in the nightly upgrade test,
   non-optional pre-migration Postgres backup. If DuckLake's catalog format shifts, the
   nightly finds out — not a user.

Honorable mentions: bollard/Podman compat quirks (pin minimum Podman version); Incus on
hosted runners (containers fine without KVM — validate in an M0.1 spike); SSE worker
starvation under gunicorn (why streaming lands in M0.5, per the PRD risk table).
