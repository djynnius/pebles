# HOWTO

Pebbles is mid-Phase 0. A single container already boots the control plane (milestone
M0.2); users, sessions, and the lake arrive with M0.3–M0.5. What you can do today:

## Run it

```sh
docker login ghcr.io          # if the package is private
docker run -d --name pebbles \
  -e PEBBLES_ROLE=main \
  -p 8080:8080 \
  -v pebbles-config:/var/lib/pebbles \
  -v pebbles-home:/home \
  ghcr.io/djynnius/pebles:edge
```

**Both volumes are required.** `pebbles-config` holds accounts, catalogs and
the lake; `pebbles-home` holds every user's files, notebooks and dashboards.
Upgrading is "pull the new image, recreate the container with the same
volumes" — anything not on a volume is lost when the container is recreated
(pebblesd logs a warning at boot if `/home` isn't on a mounted volume).

Open http://localhost:8080 — you'll land on the login page. Create the first user
through the privileged API (admin screens arrive in Phase 1):

```sh
docker exec pebbles curl -s --unix-socket /run/pebbles/pebblesd.sock \
  -H 'Content-Type: application/json' \
  -d '{"username":"maya","password":"choose-a-password"}' http://pebblesd/users
```

That provisions a real UNIX account (uid in the reserved 70000+ range, private
`/home/maya`) and the same password signs into the web UI. From there: **Lake
catalogs** creates a DuckLake catalog (the form shows the equivalent
`CREATE CATALOG` SQL), **Files** browses your home with upload/download/folders
(the same files you reach over SFTP — `sftp maya@<host>` with your Pebbles
password), **Notebooks** gives you SQL, Python and R cells (state
persists across cells; files live in `~/notebooks`; numpy/pandas/scikit-learn/
polars/tidymodels and friends are preinstalled via miniforge, and
`pip install --user` or personal conda envs add more), **Dashboards** turns saved
SQL into rearrangeable tiles (tables, big-number stats, bar charts), **Jobs**
builds scheduled or manual pipelines whose every task runs as you on the engine
you pick (Airflow works underneath, invisibly), **Repos** clones into `~/repos`
and gives you the stage/commit/push loop with your own SSH key or PAT (set them
under git settings — Pebbles never holds a shared credential), and the
**SQL editor** runs
queries against the lake as your own UNIX user, streaming results over SSE — try
`SELECT 42 AS answer;` or load a CSV from your home with
`read_csv_auto('/home/maya/file.csv')`. Time travel works:
`SELECT * FROM t AT (VERSION => 1);`. **Nkoyo**, the assistant, chats via your
own Ollama models (point it at an endpoint under Settings → Nkoyo; rescan
auto-detects Ollama across the fleet — nothing leaves your hosts). `/healthz`
shows the daemon's role proxied over the privileged socket. Omit `-e PEBBLES_ROLE=…` and run with `-it` to get the
setup wizard instead. Podman (rootful) works with the same flags.

### Add an engine

Mint a single-use join token under **Settings → Compute runtime** in the UI
(shown exactly once), or via the API:

```sh
docker exec pebbles curl -s -X POST --unix-socket /run/pebbles/pebblesd.sock \
  http://pebblesd/cluster/tokens
```

An engine booted *without* a token appears under Settings as **pending
approval** — approve or reject it there.

Then boot another container (any host that shares `/home` and the lake storage)
with the token:

```sh
docker run -d --name pebbles-engine \
  -e PEBBLES_ROLE=engine \
  -e PEBBLES_MAIN=http://<main-host>:7443 \
  -e PEBBLES_JOIN_TOKEN=<token> \
  -v pebbles-home:/home -v pebbles-lake:/var/lib/pebbles/lake \
  ghcr.io/djynnius/pebles:edge
```

It registers, receives the account snapshot, and appears on the Engines page.
Sessions opened with `{"engine": "<name>"}` run on it as your own uid.

### Incus

Grab `metadata.tar.xz` + `rootfs.tar.xz` from the Image workflow's
`pebbles-incus-amd64` artifact (or convert locally with
`image/lxc/oci-to-incus.sh`), then:

```sh
echo "root:70000:5000" | sudo tee -a /etc/subuid /etc/subgid   # ADR-001 range
sudo systemctl restart incus
incus image import metadata.tar.xz rootfs.tar.xz --alias pebbles
incus profile create pebbles && incus profile edit pebbles < deploy/incus/profile.yaml
incus launch pebbles pebbles-main -p default -p pebbles -c environment.PEBBLES_ROLE=main
incus list pebbles-main   # open http://<its IP>:8080
```

## Admins

Admin rights = membership in the Pebbles group **`admins`**. Admins manage
users and groups, cluster join tokens, engine approvals, and Nkoyo's models;
everyone else gets their own workspace. On first boot after an upgrade (or
when the first user is created) the **first account ever created** becomes
the admin if nobody else is. To make someone else an admin:

```sh
# at boot: comma-separated usernames
docker run ... -e PEBBLES_ADMINS=admin,maya ...

# or live, from the host, through the privileged socket
docker exec pebbles curl -s --unix-socket /run/pebbles/pebblesd.sock \
  -H 'Content-Type: application/json' -d '{"username":"admin"}' \
  http://pebblesd/groups/admins/members
```

After that, admins manage everything from the UI: **Users** (add, disable,
delete, reset password, make admin), **Groups** (create, delete, members) and
**Engines** (who may use each engine). Everyone changes their own password
under Settings → Security. The last admin can't be removed or disabled.

## Catalog actions

Right-click in the **Catalog** tree: a catalog offers **New schema**; a schema
offers **Upload table…** (CSV, TSV, Parquet or JSON → a new table) and
**Rename schema…**; a table offers **Rename table…**. A table's page also has
a **New schema** button. Renaming a table keeps its history; renaming a schema
copies its tables into the new schema (DuckDB can't rename schemas yet), so
their time-travel history starts over. Catalogs can't be renamed yet.

## Agent skills

Settings → **Agent skills** lists the skills Nkoyo reads (yours in
`~/.pebbles/skills`, built-in ones like `pebbles-guide` in
`/opt/pebbles/skills`). **Install** takes `owner/repo`, `owner/repo/skill`
(e.g. `anthropics/skills/pdf`) or a git URL and clones it with *your* git
credentials; set `PEBBLES_SKILLS_GIT_BASE=https://git.internal` on the main to
resolve `owner/repo` against a mirror when you're air-gapped. **Create** lets
you describe a skill and have Nkoyo draft the `SKILL.md`, then edit and save
it. Nkoyo can also create catalogs, schemas, notebooks and jobs for you — each
one only after you approve it in the chat.

**Session memory.** Each signed-in user gets one engine session (512 MB by
default, reused across their browser tabs and logins, released on sign-out).
The engine's total budget defaults to 75% of the container's memory; set
`PEBBLES_ENGINE_MEMORY_BYTES` / `PEBBLES_SESSION_MEMORY_BYTES` to tune.

## Back up (and restore) your installation

Two things hold all state, both on the main's host:

1. **The config volume** (`/var/lib/pebbles`) — Postgres (DuckLake catalog
   metadata, Airflow, grants), user account snapshots, workflows, tokens.
2. **The lake root** (`/var/lib/pebbles/lake` inside the same volume by
   default) — the Parquet data files. DuckLake writes them append-mostly, so
   incremental copies stay cheap.

**Automated (REQ-50):** the main dumps the Postgres catalog daily to
`/var/lib/pebbles/backups/scheduled-<ts>.sql` (plus a `.lake-manifest`
listing every lake file with its size, so you can verify a lake copy matches
the dump). Retention keeps the newest 7. Tune with
`PEBBLES_BACKUP_INTERVAL_SECS` (default 86400; `0` disables) and
`PEBBLES_BACKUP_KEEP` (default 7). Pre-migration backups (taken automatically
before any schema upgrade) are never pruned.

**Manual procedure** — run from the main's host:

```sh
# 1. catalog dump (consistent snapshot of all Postgres databases)
docker exec pebbles sh -c \
  'su postgres -s /bin/sh -c "pg_dumpall -h /run/postgresql"' > pebbles-catalog.sql

# 2. lake + config files (rsync keeps repeat runs incremental)
docker cp pebbles:/var/lib/pebbles ./pebbles-backup/     # or rsync the volume path
```

**Restore:** start a fresh container on an empty volume, stop it, copy the
backed-up volume contents in (numeric uids matter — preserve them), start it
again; accounts and role are restored from the snapshot on boot (REQ-09/11).
For a catalog-only restore, feed the dump to psql as the postgres user before
first login. Verify the lake against the paired `.lake-manifest`.

## Explore the product

- **UI prototype:** open `ui_ux.html` in a desktop browser (it is a self-extracting
  bundle — give it a moment to unpack). Log in with the demo accounts shown on the
  login screen. Viewport must be ≥ 700 px wide; the design gates mobile.
- **Read the docs** in this order: `README.md` → `pebbles-prd.md` →
  `pebbles-spec-v2.md` → `pebbles-implementation-plan.md`.

## Work on the scaffold

Prerequisites: Rust (stable, via rustup) and [uv](https://docs.astral.sh/uv/).

```sh
# Rust workspace: daemon, API types, runtime/identity/session crates, sql-runner
cargo test                      # build + run all workspace tests
cargo fmt --check               # formatting
cargo clippy -- -D warnings     # lints (CI treats warnings as errors)

# Flask web tier (serves the SPA + the /api JSON surface)
cd web
uv sync                         # create venv + install deps
uv run ruff check .             # lint
uv run pytest                   # tests

# React UI (the workbench; built into web/pebbles_web/static/app)
cd web/frontend
npm ci                          # install deps
npm run dev                     # dev server with /api proxied to :8080
npm run typecheck && npm run build

# Native dev loop (pebblesd + Flask against a scratch config dir; no container needed)
scripts/dev/run.sh
```

## Build the image (optional — CI does this for you)

```sh
docker build -f image/Containerfile -t pebbles:dev .    # or: podman build
scripts/smoke/install-to-first-query.sh pebbles:dev     # boot + health-check it
```

This file grows a real install guide as Phase 0 milestones land (see the implementation
plan §9).
