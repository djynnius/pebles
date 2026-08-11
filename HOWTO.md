# HOWTO

Pebbles is pre-code (Phase 0 starting), so there is nothing installable yet. What you
can do today:

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
