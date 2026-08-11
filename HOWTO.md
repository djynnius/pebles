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
`/home/maya`) and the same password signs into the web UI. From there: **Lake
catalogs** creates a DuckLake catalog (the form shows the equivalent
`CREATE CATALOG` SQL), and the **SQL editor** runs queries against it as your own
UNIX user, streaming results over SSE — try `SELECT 42 AS answer;` or load a CSV
from your home with `read_csv_auto('/home/maya/file.csv')`. Time travel works:
`SELECT * FROM t AT (VERSION => 1);`. `/healthz` shows the daemon's role proxied
over the privileged socket. Omit `-e PEBBLES_ROLE=…` and run with `-it` to get the
setup wizard instead. Podman (rootful) works with the same flags.

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
