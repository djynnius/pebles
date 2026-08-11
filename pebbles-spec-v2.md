# Pebbles — product & design specification, v2

Supersedes the v1 handoff spec. Merges the v15 prototype (UX source of truth) with the
new architecture direction: unified container image, role chosen at setup, shared
multi-user compute with opt-in dedicated sessions, per-group/per-user compute access,
Flask web tier over Rust services, first-class git, Airflow under the hood.

**Status:** design prototype only. No backend exists. Every number, table and username in
the UI is sample data.

**Confidence markers:**
- **[decided]** — stated explicitly by you (v1 conversation or this one).
- **[new]** — stated explicitly by you in the current direction.
- **[built]** — visible in the v15 prototype; the prototype is the source of truth.
- **[proposed]** — my design judgement reconciling old and new. **Please confirm or correct.**
- **[open]** — known gap, undesigned.

---

## 1. What Pebbles is

A self-hosted data analysis platform — data lakes, notebooks, jobs and dashboards —
positioned as a free alternative to Databricks and Snowflake. **[decided]**

The differentiator is deployment economics: it installs as Docker, Podman **[new]** or LXC
containers on hardware you already own. No licence cost, no per-second compute billing.
**[decided]**

Target deployment is hybrid / bring-your-own-cloud. **[decided]**
Sample data domain throughout is healthcare claims. **[decided]**

### Deliberate non-goals
- Not Spark. The engine is DuckDB. **[decided]**
- Not a mobile product. Below 700px the app shows a "needs a bigger screen" gate. **[built]**

---

## 2. Deployment model — one image, role at setup **[new]**

There is **one Pebbles image**. Main app and engines are the *same container image*; what a
container *is* gets decided at setup, not at build. **[new]**

- The image contains everything: the Rust daemon, the Flask web app, DuckDB, the Python and
  R runtimes, Airflow, and git. First boot picks which services activate. **[proposed]**
- **Role selection** happens at first boot, via environment variable / cloud-init for
  scripted installs or a terminal setup wizard for interactive ones:
  - `PEBBLES_ROLE=main` — activates control plane: Postgres catalog, Airflow scheduler,
    Flask UI, `pebblesd` in supervisor mode. Exactly one main per workspace.
  - `PEBBLES_ROLE=engine` — activates compute only: `pebblesd` in engine mode plus the
    kernels. Requires `PEBBLES_MAIN=<host:port>` and a join token.
  **[proposed]**
- The role is stored in the container's config volume and is sticky across restarts.
  Converting a container between roles means re-running setup, not rebuilding. **[proposed]**
- The main can also run engine sessions itself (useful for a single-box install: one
  container is the whole product). A Settings toggle governs whether the main accepts
  compute work. **[proposed]**

### Registering engines **[new]**

Engines are registered *on the main*. **[new]** Flow:

1. Admin opens **Engines → Register engine** on the main. The screen shows a
   **single-use join token** and a copy-paste run command for Docker/Podman and for LXC.
   **[decided]** Each token registers exactly one engine and expires after a short window
   (default 24 h) if unused; tokens are listed and revocable under Settings → Workspace ·
   admin → Compute runtime. Scripted fleet installs mint N tokens via the API rather than
   sharing one. **[proposed details]**
2. A new container booted with that token handshakes with the main over the API, reports
   its resources (CPU, RAM, GPU, disk), and appears in the Engines list. **[proposed]**
3. A container booted pointing at the main *without* a valid token appears as **Pending
   approval** — an admin approves or rejects it from the Engines list. **[proposed]**
4. At registration time (and editable afterwards in engine config) the admin assigns
   **access**: everyone, a group, or a single user. Only members of that group / that user
   can see and attach the compute. **[new]** The v15 prototype already renders this as the
   `No access · Tomas Reyes only` row state. **[built]**

> Networking note: v1's `pebbles0` bridge with static DHCP leases assumed the main *creates*
> engine containers. In the new model engines may be created by the admin on any host, so
> the bridge is no longer guaranteed. Registration records the engine's reachable address;
> the internal-DNS convention `<engine>.engines.pebbles.local` is kept where the main can
> control DNS, and falls back to the registered address where it can't. **[proposed]**

---

## 3. Architecture

### Process split — Rust services, Flask web **[new]**

- **`pebblesd` (Rust)** — the long-running privileged service, one static binary, present
  in every container. **[new — Rust confirmed]** It owns:
  - Docker/LXD sockets and container lifecycle (where applicable)
  - UNIX account and group management (`useradd`, `usermod -aG`, …)
  - Session brokering: starting/stopping per-user engine session processes under the
    correct uid/gid
  - Health loops (engine heartbeat every 10s; lost engines flagged and, if main-managed,
    restarted) **[decided v1, kept]**
  - Git operations executed as the requesting user (via libgit2 / `git2-rs`) **[proposed]**
  - A local API (REST or gRPC over a unix socket / mTLS between hosts) that everything
    else calls **[proposed]**
- **Web app (Python / Flask)** — serves the entire UI. **[new]** It is deliberately thin:
  - **Boundary rule: Flask never touches a container socket, never runs as root, never
    spawns user processes, never reads another user's files.** Every privileged action is
    an API call to `pebblesd`. **[proposed]**
  - Stateless apart from session cookies; all state lives in Postgres and on disk under
    `pebblesd`'s control. **[proposed]**
  - Streaming (notebook cell output, job logs, Nkoyo tokens) via SSE or WebSockets under
    gunicorn; plan this in from the start rather than bolting it on. **[proposed]**
- **Airflow** powers jobs under the hood. **[new — confirmed]** It runs on the main.
  Users never see Airflow's own UI; the Pebbles Jobs screens are the only face.
  Workflow definitions compile to DAGs; each task's operator calls `pebblesd`:
  "run notebook X on engine Y as user Z, with a shared session." **[proposed]**
- **Postgres** on the main holds the DuckLake catalog, users/groups/grants metadata,
  engine registry, and Airflow's own metadata DB. **[decided v1, kept]**

### Compute — "Engines"

The user-facing noun is **Engine**, never "cluster". **[decided]**

- Backend is Docker, Podman **[new]**, or LXC — all supported; Settings sets the default
  for new engines, with per-engine override. **[decided]** Podman is driven through its
  Docker-compatible API and is **rootful-only in v1** — rootless uid remapping would break
  the host-uid identity model (§3 Identity). **[new + proposed detail]** The LXC backend
  targets **Incus** (the community LXC manager); LXD compatibility is incidental, not
  claimed. **[proposed]** LXC is the better fit for GPU passthrough and long-lived
  interactive engines; Docker/Podman for short-lived job engines. **[inferred v1, kept]**
- Per-engine config: memory limit, CPU limit, scratch volume, host pinning, auto-stop on
  idle, enabled kernels — plus, now, **access** (everyone / group / user), **max concurrent
  sessions**, and **allow dedicated sessions** (on/off). **[built + new]**

### Sessions — shared by default, dedicated on request **[new]**

This replaces v1's one-session-per-engine lock.

- An engine hosts **multiple concurrent sessions**, one per attached user, up to its
  configured maximum. **[new]**
- **Each session is its own process, running as that user's uid/gid, with their home
  bind-mounted at `/workspace`.** The *container* is shared; the *processes* are not.
  DuckDB's single-process nature applies per session, not per engine, so the identity
  model survives intact. **[proposed — this is the load-bearing reconciliation]**
- **Engine choice is always explicit.** Attach never auto-selects an engine; the user
  picks from the Engines list. Automatic placement ("any engine with 8 GB free") is a
  possible later feature, not v1. **[decided]**
- **Dedicated mode:** when attaching, a user may tick **Dedicated**. While a dedicated
  session holds, no other session may start. This is v1's session lock, demoted from the
  only mode to an opt-in mode. **[new]**
- **Dedicated contention resolves by draining — never refusal, never preemption.**
  **[decided]** If shared sessions exist when a dedicated request is made, the engine
  enters **Draining**: no new shared sessions are admitted; existing sessions finish
  naturally or idle out; the dedicated session starts the moment the engine is empty.
  The pending reservation is visible in the Engines list and cancellable by the requester
  or an admin. Running work is never killed. If the drain hasn't completed after a
  configurable wait (default 15 min), the requester is notified and may keep waiting or
  cancel. One reservation per engine; a second dedicated request while one is pending is
  refused with the holder shown. **[decided + proposed details]**
- Dedicated sessions auto-release after 30 minutes idle (v1 rule, kept). Shared sessions
  auto-close on idle per the engine's auto-stop setting. **[built, kept]**
- Memory: each session gets a DuckDB `memory_limit`; the engine refuses a new session if
  the sum of session limits would exceed the container's memory limit. Dedicated sessions
  may claim the whole allowance — that's their point. **[proposed]**
- Jobs take **shared** sessions by default; a workflow task can be marked dedicated for
  memory-hungry stages. Consequence: the v1 known gap — "a nightly job holding a lock can
  block someone's morning" — largely dissolves. A queue/notify mechanism is now only
  needed for dedicated contention, which should be rare. **[proposed]**

**Engines list states, revised:** **[proposed — UI change needed from v15]**

| State | Meaning | Action |
|---|---|---|
| Attached (shared) | You have a session; shows `n sessions` | Open |
| Attached (dedicated) | You hold the engine exclusively | Open · Release |
| In use | Other users' sessions active, capacity remains | Attach ▾ (Shared / Dedicated) |
| Draining | Dedicated reservation pending; no new shared sessions | Cancel (requester/admin) |
| Dedicated to *user* | Someone holds it exclusively | Request dedicated (starts a drain when they release) |
| Available | Running, no sessions | Attach ▾ |
| Pending approval | Registered without valid token | Approve / Reject (admin) |
| Stopped | Container not running | Start |
| No access | Outside your grant | — |

The engine-config screen's **Session lock** panel becomes a **Sessions** panel: the list of
live sessions (user, kernel, memory, idle time), the max-sessions control, and the
allow-dedicated toggle. **[proposed]**

### Storage

Plain files plus Postgres — **DuckLake**, Postgres holding the catalog. **[decided]**

Vocabulary rule kept: the UI says **Lake** and **Engine**; DuckDB appears only in detail
views. Standard `catalog / schema / table` naming. **[decided]**

A catalog is a named storage root plus metadata: Pebbles creates the directory, registers
it in Postgres and grants the owner full rights. Schemas are folders inside that root.
The Create Catalog form and `CREATE CATALOG` / `CREATE SCHEMA` / `GRANT` SQL are equivalent
paths; the UI shows the SQL live alongside the form. **[built]** Tables carry snapshots
with time travel. **[built]**

> Multi-host storage: with engines on arbitrary hosts, catalog storage roots must be
> reachable from every engine that queries them (NFS/SMB mount, or object storage).
> The setup wizard should ask where the lake lives and verify reachability at engine
> registration. **[open — undesigned, newly urgent]**

### Identity — unchanged, and now doing more work

**Identity lives on the host, not in the containers.** **[decided]**

- Creating a Pebbles user provisions a real UNIX account: `/home/<username>`, uid, gid.
- Session processes run as the requesting user's uid/gid; homes bind-mount at `/workspace`.
- Ordinary filesystem permissions are the permission system. Two users sharing an engine
  cannot read each other's files unless the filesystem allows it — which is precisely why
  shared engines are safe. **[decided + proposed]**
- The Pebbles password is the SSH credential for the host account; SFTP drops appear in
  the Files screen. **[decided]**
- Uid/gid must be **consistent across all hosts** running engines, since homes and lake
  storage are shared. `pebblesd` on the main is the source of truth and replicates
  accounts to engine hosts at registration and on change. **[proposed]**

### Groups and access

Grants are made to **groups, never to individuals** — invariant kept. **[decided]**
Per-user compute assignment **[new]** is implemented as a grant to the user's **personal
primary group** (every UNIX user has one). The UI may say "Tomas Reyes only"; the
machinery only ever sees a group. **[proposed]**

A group is a real UNIX group; adding a member runs `usermod -aG` on every registered host,
and sessions started afterwards inherit it. Grants can target a catalog, a schema, or an
engine. **[built]**

---

## 4. Git **[new]**

Git is first-class. Users can clone repos from GitHub into Pebbles, and stage, commit and
push from the UI. **[new]**

- **Where repos live:** inside the user's home, e.g. `~/repos/<name>`. They are therefore
  visible in Files, on engines at `/workspace/repos/<name>`, and over SFTP — no separate
  repo store. **[proposed]**
- **Who runs git:** `pebblesd`, always as the requesting user's uid, using the credentials
  in that user's home (`~/.ssh` keys or an HTTPS token). Credential isolation falls out of
  the identity model; Pebbles never holds a shared GitHub credential. **[proposed]**
- **Credentials UI:** Settings → new **Git** section: display name/email for commits,
  SSH key generation with copyable public key, or a PAT field stored in the user's home
  with `0600` perms. **[proposed]**
- **Workbench integration:** a fifth icon on the workbench rail — **Source control**
  (branch icon), VS Code-style: **[proposed]**
  - current branch + switcher, ahead/behind counts
  - changed-files list; click to stage/unstage; diff opens as a document tab
  - commit message box; Commit and Commit & push buttons; Pull
  - file-tree entries in the Files panel get git status badges (M/A/U)
- **Files screen:** a **Clone repository** action beside New folder / Upload; paste a
  GitHub URL, pick destination. **[proposed]**
- **Workflows:** a workflow task can reference a notebook *in a repo at a ref*, making
  pipelines versioned and reproducible. An approved Auto ETL pipeline can be committed to
  a repo — this answers v1 open question 3 (versioned, re-runnable artifacts). **[proposed]**
- Scope guard: this is porcelain for the common loop (clone, edit, stage, commit, push,
  pull, branch). Merge-conflict resolution beyond "take mine / take theirs / edit file"
  is out of scope for v1 of the feature. **[proposed]**

---

## 5. Screen inventory

21 routes in v15 **[built]**, plus deltas required by this direction:

**Auth & shell** — unchanged: progressive login (`admin` / `isantm` demo), mobile gate
below 700px.

**Workspace**
| Route | Screen | Delta |
|---|---|---|
| `home` | Greeting, KPI row incl. "$0 licence cost", Nkoyo ask bar, recents | — |
| `workspace` | Files, mapping to `/home/<user>` | + Clone repository action, git badges **[proposed]** |
| `catalog` | Catalog browser — the investor money shot | — |
| `newcatalog` | Create catalog with live SQL | — |
| `nkoyo` | Full-page assistant chat | — |

**Analysis** — `notebook`, `sql`, `dashboards`, `dashboard` share the workbench shell.
Delta: fifth rail panel, Source control. **[proposed]**

**Data engineering** — `jobs`, `jobbuilder`, `run`, `ingest`, `autoetl`. Deltas: per-task
session mode (shared default / dedicated); task source can be a repo ref. **[proposed]**

**Infrastructure**
| Route | Screen | Delta |
|---|---|---|
| `engines` | Availability view | revised states table (§3); Register engine action **[proposed]** |
| `engineconfig` | Per-engine config | Sessions panel replaces Session lock; Access (everyone/group/user); max sessions; allow dedicated **[proposed]** |
| `hosts` | Node inventory | shows role badge (Main / Engine) per container **[proposed]** |

**Admin** — `users`, `groups`, `usage`, `settings`. Settings gains a **Git** section
(personal) and, under Workspace · admin, **Compute runtime** keeps default backend
(Docker/LXC) and gains join-token management. **[proposed]**

---

## 6. Design system — unchanged **[decided, built]**

- Monokai in two themes; Night is full Monokai, Daylight the same hues darkened for white.
  All colour via CSS custom properties on `[data-pb-theme]`; no hard-coded colours.
  Accent pink `#F92672` in both themes. Palette: bg `#272822`, fg `#F8F8F2`, pink
  `#F92672`, green `#A6E22E`, yellow `#E6DB74`, blue `#66D9EF`, purple `#AE81FF`, orange
  `#FD971F`, comment `#75715E`.
- Wordmark `pe{b}les` in Cascadia Code, braces in accent pink; collapses to `{b}` in the
  icon rail; favicon `{b}`.
- IBM Plex Sans for UI, IBM Plex Mono for code/paths/aligned figures.
- Sidebar collapses to a 62px icon rail; active marker is the left pink dot with its slot
  reserved on every row.
- Nkoyo silhouette avatar in an accent ring, in the topbar, assistant panel, Nkoyo page,
  Home, Ingestion and Auto ETL.

## 7. Workbench conventions — one addition

The shared shell, 46px icon rail, context-sensitive Contents panel, JupyterLab-style
routing tabs, and the 1280px overlay/push responsive rule all stand as built. Panels stay
folded by default at every width; navigating closes an overlaying panel. **[decided, built]**

Addition: **Source control** as the fifth rail panel (§4). Below 1280px it overlays like
the others. **[proposed]**

## 8. Nkoyo — unchanged in substance **[decided]**

Agent harness, not a chat box. Ollama endpoints auto-detected on the fleet; separate
models for planning, code/SQL, embeddings; max agent steps. Folder-based skills
(`~/.pebbles/skills` personal, `/opt/pebbles/skills` workspace, org skills enforceable).
Tool permissions graded always-on / ask-first / blocked, never exceeding the user's own
grants. Everything in-cluster; no data leaves the hosts.

Auto ETL: profile → model → clean → load; Nkoyo proposes, the user approves; nothing runs
until Approve & run; low-confidence steps unticked with confidence shown; runs saveable as
pipelines — and now committable to a repo. **[decided + proposed]**

One new capability worth adding: Nkoyo tools for git ("commit this notebook with message
…"), gated ask-first by default. **[proposed]**

## 9. Implementation notes carried forward **[built — hard-won, keep]**

- The US map is baked geometry (`us-atlas` → `d3.geoAlbersUsa` → 900×520 viewBox,
  adaptively simplified, compiled into `us-states.js`). Never fetch it at runtime.
- No `min-height:100%` inside scrolling flex columns — it loops layout resolution and
  froze the browser. Same for `aspect-ratio` inside nested auto-row grids.
- Route restore is guarded by a boot sentinel written before render and cleared in
  `componentDidUpdate`; a failed route falls back to Home for that load only. Do not
  reimplement on a timer.
- Route storage key is versioned (`pebbles.route.v4`); bump on any route removal.
- Prototype-specific: right-click delegated from `document` via `data-ctx`; values
  interpolated inside SVG `<text>` render at zero size.

## 10. Open questions, revised

1. ~~Engine lock contention~~ — resolved: draining model (§3). **[decided]**
2. ~~Concurrency ceiling / session scheduling~~ — resolved: multi-session engines with
   always-explicit engine choice; automatic placement deferred. **[decided]**
3. ~~Auto ETL trust~~ — answered by committing approved pipelines to repos, pending your
   confirmation. **[proposed]**
4. R support is first-class in the UI, but packaging R into the unified image needs
   scoping (image size vs. an optional layer). **[open]**
5. Backup, upgrade and multi-host failover — still undesigned. Upgrade is now more
   tractable: one image, so upgrading = pulling the new image and re-running with the same
   config volume; but catalog migrations need a story. **[open]**
6. Empty, loading and error states exist nowhere. **[open]**
7. Sharing beyond the instance (dashboards) — still no external/public story. **[open]**
8. **New:** lake storage reachability across hosts (NFS / object storage?) — see §3
   Storage. **[open]**
9. **New:** main-host failure. Engines can keep running sessions, but nothing new can
   start. Is "degraded but alive" acceptable for v1? **[open]**
10. ~~Join-token lifecycle~~ — resolved: single-use tokens with expiry, listed and
    revocable in admin settings; API-minted for scripted installs (§2). **[decided]**
    Remaining sliver: revoking an *already-registered* engine (deregister flow) — likely
    just a Remove action on the Engines list that invalidates its credentials. **[open]**

## 11. Provenance

Merged from: the v1 spec (reconstructed from `Pebbles.dc.html` and the design
conversation), the v15 prototype (`Pebbles__15_.html`, UX source of truth), and the new
architecture direction stated in the current conversation. Everything **[proposed]** is
reconciliation judgement — please correct.
