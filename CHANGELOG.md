# Changelog

All notable changes to Pebbles are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions will follow
[Semantic Versioning](https://semver.org/) once releases begin.

## [Unreleased]

### Added
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
