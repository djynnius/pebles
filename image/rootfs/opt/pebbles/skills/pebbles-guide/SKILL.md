---
name: pebbles-guide
description: How Pebbles works and how to do things in it — use for any "how do I…" question about the platform.
---

# Pebbles — how things work

Pebbles is a self-hosted data platform: a lake of **catalogs → schemas → tables**
(DuckLake: Parquet files + a Postgres catalog, with time travel), notebooks, a SQL
editor, dashboards and jobs, running on **Engines** (containers that run queries).
Say "Lake" and "Engine" — never "cluster" or "credits".

**Identity.** Every Pebbles user is a real UNIX account (uid 70000+); every query,
cell and job runs *as that user*. Access is granted to UNIX **groups** — there is no
second permission system. Admins are members of the `admins` group.

## Where things are (left sidebar)

- **Home** — greeting, fleet stats, "Ask Nkoyo", recently opened items.
- **Files** — your home folder (`/home/<you>`). Upload, download, New folder / New file,
  rename, delete (right-click a row for actions). Same files you reach over SFTP.
- **Catalog** — browse catalogs, schemas and tables. Click a table for Schema,
  Sample, Snapshots (time travel), Lineage and Permissions. A 🔒 catalog is one you
  haven't been granted.
- **Nkoyo** — this assistant.
- **Notebooks** — SQL, Python, R and Markdown cells; state carries across cells;
  files live in `~/notebooks`. Import/export Jupyter `.ipynb`.
- **SQL editor** — run queries against a catalog; Download CSV; Add to dashboard.
- **Dashboards** — tiles from saved SQL (tables, big numbers, bar/line charts), filters,
  drag to rearrange, full-screen, PDF.
- **Jobs** — pipelines of tasks (sql/python/r/shell/notebook) run manually or on a cron
  schedule, each task as you. "Run now", run history under the ▸ arrow.
- **Ingestion / Auto ETL** — Auto ETL profiles a file or table and proposes cleaning and
  a star schema; nothing is written until you approve.
- **Engines / Hosts** — the compute fleet. **Admin → Users, Groups, Usage** for admins.
- **Account & Settings** (bottom left) — Profile, Security & sessions (change password),
  Home directory, Git & repos (SSH key / PAT), Nkoyo model, Agent skills; admins also see
  API tokens (engine join tokens), Compute runtime, Engine approvals.

## How to…

- **Create a catalog:** Catalog → "New catalog" (equivalent SQL: `CREATE CATALOG name;`).
  You own it; names are letters, digits and `_`.
- **Create a schema:** right-click the catalog in the Catalog tree → New schema, or the
  "New schema" button on a table's page (pick the catalog, type the name).
  SQL: `CREATE SCHEMA "catalog"."schema";`
- **Load a file as a table:** right-click a schema → Upload table… (CSV, TSV, Parquet,
  JSON). Or in SQL: `CREATE TABLE cat.sch.t AS SELECT * FROM read_csv_auto('/home/<you>/file.csv');`
- **Rename:** right-click a table → Rename table (keeps history). Right-click a schema →
  Rename schema — this copies its tables into the new schema, so their time-travel history
  does not carry over. Catalogs can't be renamed yet.
- **Share a catalog:** open any table in it → Permissions → grant a group (only the
  catalog's owner or an admin can). To share with one person, grant their personal group
  (same name as their username). Admin → Groups creates team groups and adds members.
- **Time travel:** `SELECT * FROM t AT (VERSION => 3);` — versions are listed on the
  table's Snapshots tab.
- **Query a file without loading it:** `SELECT * FROM read_parquet('/home/<you>/x.parquet');`
- **Schedule a job:** Jobs → New job → add tasks, set a cron schedule (e.g. `0 6 * * *`)
  or leave manual → Save → Run now to test.
- **Chart in a notebook:** matplotlib/plotnine figures render inline; return a pandas or
  R data frame as the last expression to get a table.
- **Install Python/R packages:** `pip install --user <pkg>` in a Python cell, or a personal
  conda env; R packages to your user library.
- **Use git:** Settings → Git & repos → generate an SSH key (add the public key to your git
  host) or save a PAT; clone into `~/repos`.
- **Change your password:** Settings → Security & sessions.
- **Add an engine (admins):** Engines → Register engine mints a single-use join token;
  start another Pebbles container with `PEBBLES_ROLE=engine`, `PEBBLES_MAIN` and
  `PEBBLES_JOIN_TOKEN`.
- **Add skills for me:** Settings → Agent skills → install by name (`owner/repo`) or
  describe a custom skill and let me draft it.

## What I (Nkoyo) can do for you

Read-only, any time: list your catalogs, run SELECT queries, list and read your files.
With your approval each time: create a catalog, create a schema, create a notebook,
create a job, write a file, run a statement that changes data. Everything runs as you,
so I can never see or change anything you can't. When a request needs one of the
approval tools, say exactly what you'll create and ask first.

## Troubleshooting

- "You don't have access to <catalog>" — ask its owner or an admin for a grant.
- A cell or query is slow the first time — the engine session is starting, or a
  library (e.g. matplotlib) is building its cache.
- Session memory: each user gets one engine session (512 MB by default); sign-out
  releases it.
