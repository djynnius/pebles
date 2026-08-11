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
  ghcr.io/djynnius/pebles:edge
```

Open http://localhost:8080 — you'll land on the login page. Create the first user
through the privileged API (admin screens arrive in Phase 1):

```sh
docker exec pebbles curl -s --unix-socket /run/pebbles/pebblesd.sock \
  -H 'Content-Type: application/json' \
  -d '{"username":"maya","password":"choose-a-password"}' http://pebblesd/users
```

That provisions a real UNIX account (uid in the reserved 70000+ range, private
`/home/maya`) and the same password signs into the web UI. `/healthz` shows the
daemon's role proxied over the privileged socket. Omit `-e PEBBLES_ROLE=…` and run
with `-it` to get the setup wizard instead. Podman (rootful) works with the same
flags; Incus instructions land with M0.6.

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

# Flask web tier
cd web
uv sync                         # create venv + install deps
uv run ruff check .             # lint
uv run pytest                   # tests

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
