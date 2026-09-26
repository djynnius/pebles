"""Auto ETL (REQ-46): profile → propose → approve → load.

Deliberately rule-based, not model-driven: the proposals come from DuckDB's
SUMMARIZE statistics and a handful of transparent heuristics, so Auto ETL
works identically on an air-gapped box with no Ollama endpoint. Every function
here is pure — profiling and loading run elsewhere, through the requesting
user's own engine session, and *nothing mutates before the user approves*
(REQ-46: profiling is read-only; the approved plan becomes a saved workflow).

Confidence semantics: steps at >= 0.8 arrive ticked; anything lower arrives
unticked with its confidence shown, exactly as the PRD words it.
"""

import os
import re

#: identifier for generated tables/columns
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
#: numeric DuckDB types that make natural measures
NUMERIC = re.compile(r"INT|DECIMAL|DOUBLE|FLOAT|REAL|HUGEINT|NUMERIC", re.IGNORECASE)
#: ISO-looking date / timestamp strings
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")
#: column names that smell temporal
TEMPORAL_NAME = re.compile(r"(date|time|_at$|_on$|timestamp)", re.IGNORECASE)

TICK_AT = 0.8
#: a dimension must repeat: distinct values at most half the rows
DIM_MAX_RATIO = 0.5
#: numeric columns this unique are identifiers, not measures
KEY_UNIQUE_RATIO = 0.95
KEY_NAME = re.compile(r"(^id$|_id$|^id_|_key$|^key$|uuid|guid)", re.IGNORECASE)
TEMPORAL_TYPE = re.compile(r"DATE|TIME", re.IGNORECASE)


def is_key(name: str, ctype: str, unique_ratio: float) -> bool:
    """Identifiers: named like one, or a (near-)unique integer column."""
    if KEY_NAME.search(name):
        return True
    return bool(re.search(r"INT", ctype, re.IGNORECASE)) and unique_ratio >= KEY_UNIQUE_RATIO


def source_expr(source: dict) -> str | None:
    """The FROM expression for a source, or None if it can't be trusted.

    Files are home-relative (the kernel's cwd is the user's home, and the
    kernel runs as the user — permissions bound what it can read); tables are
    bare identifiers in the attached catalog.
    """
    kind = source.get("kind")
    if kind == "table":
        name = source.get("name", "")
        return name if IDENT.match(name) else None
    if kind == "file":
        path = os.path.normpath("/" + str(source.get("path", "")).strip()).lstrip("/")
        if not path or path.startswith("..") or "'" in path:
            return None
        ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
        reader = {
            "csv": "read_csv_auto",
            "tsv": "read_csv_auto",
            "txt": "read_csv_auto",
            "parquet": "read_parquet",
            "json": "read_json_auto",
            "ndjson": "read_json_auto",
            "jsonl": "read_json_auto",
        }.get(ext)
        if reader is None:
            return None
        return f"{reader}('{path}')"
    return None


def base_name(source: dict) -> str:
    """A snake_case dataset name derived from the source."""
    raw = source.get("name") or os.path.basename(str(source.get("path", "dataset")))
    raw = raw.rsplit(".", 1)[0]
    return snake(raw) or "dataset"


def snake(name: str) -> str:
    """Lowercase snake_case; empty string if nothing identifier-ish survives."""
    out = re.sub(r"[^A-Za-z0-9]+", "_", name.strip())
    out = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", out).lower()
    out = re.sub(r"_+", "_", out).strip("_")
    if out and out[0].isdigit():
        out = f"c_{out}"
    return out


def propose(columns: list, row_count: int, source: dict) -> dict:
    """Cleaning steps + star-schema model from SUMMARIZE statistics.

    `columns` rows carry (at least): column_name, column_type, min, max,
    approx_unique, null_percentage — DuckDB's SUMMARIZE shape.
    """
    steps: list = []
    renames: dict[str, str] = {}

    for col in columns:
        name = col.get("column_name", "")
        ctype = str(col.get("column_type", ""))
        nulls = float(col.get("null_percentage") or 0)
        clean = snake(name)

        if clean and clean != name:
            renames[name] = clean
            steps.append(
                {
                    "id": f"rename_{clean}",
                    "kind": "rename",
                    "column": name,
                    "to": clean,
                    "description": f'Rename "{name}" → {clean}',
                    "confidence": 0.95,
                }
            )

        if ctype.upper().startswith("VARCHAR"):
            lo, hi = str(col.get("min") or ""), str(col.get("max") or "")
            if DATE_RE.match(lo) and DATE_RE.match(hi):
                cast, conf = "DATE", 0.9
            elif TS_RE.match(lo) and TS_RE.match(hi):
                cast, conf = "TIMESTAMP", 0.9
            elif TEMPORAL_NAME.search(name):
                cast, conf = "TIMESTAMP", 0.6
            else:
                cast = None
            if cast:
                steps.append(
                    {
                        "id": f"cast_{clean or name}",
                        "kind": "cast",
                        "column": name,
                        "to_type": cast,
                        "description": f'Cast "{name}" to {cast} (TRY_CAST — bad values become NULL)',
                        "confidence": conf,
                    }
                )

        if nulls >= 60:
            steps.append(
                {
                    "id": f"drop_col_{clean or name}",
                    "kind": "drop_column",
                    "column": name,
                    "description": f'Drop column "{name}" ({nulls:.0f}% null)',
                    "confidence": 0.6,
                }
            )
        elif 0 < nulls <= 5:
            steps.append(
                {
                    "id": f"drop_nulls_{clean or name}",
                    "kind": "drop_null_rows",
                    "column": name,
                    "description": f'Drop rows where "{name}" is null ({nulls:.1f}%)',
                    "confidence": 0.5,
                }
            )

    steps.append(
        {
            "id": "dedupe",
            "kind": "dedupe",
            "description": "Drop exact duplicate rows (SELECT DISTINCT)",
            "confidence": 0.5,
        }
    )
    for s in steps:
        s["ticked"] = s["confidence"] >= TICK_AT

    # --- star schema -------------------------------------------------------
    dropped = {s["column"] for s in steps if s["kind"] == "drop_column" and s["ticked"]}
    # anything with a drop *proposal* (ticked or not) makes a poor dimension —
    # if the user keeps it, it stays as a plain column instead
    drop_proposed = {s["column"] for s in steps if s["kind"] == "drop_column"}
    # columns that become dates/timestamps via a proposed cast behave as dates
    cast_temporal = {s["column"] for s in steps if s["kind"] == "cast"}
    dims, measures, keeps = [], [], []
    dim_cap = max(200, row_count // 20) if row_count else 200
    for col in columns:
        name = col.get("column_name", "")
        if name in dropped:
            continue
        final = renames.get(name, name)
        ctype = str(col.get("column_type", ""))
        uniq = int(col.get("approx_unique") or 0)
        ratio = (uniq / row_count) if row_count else 1.0
        if is_key(final, ctype, ratio):
            keeps.append(final)  # identifiers ride on the fact, never summed
        elif TEMPORAL_TYPE.search(ctype) or name in cast_temporal:
            keeps.append(final)  # dates are fact attributes, not dim tables
        elif NUMERIC.search(ctype):
            measures.append(final)
        elif (
            2 <= uniq <= dim_cap
            and ratio <= DIM_MAX_RATIO
            and name not in drop_proposed
        ):
            dims.append({"column": final, "table": f"dim_{final}"})
        else:
            keeps.append(final)

    name = base_name(source)
    return {
        "name": name,
        "cleaning": steps,
        "model": {
            "kind": "star" if dims else "table",
            "fact": f"fact_{name}" if dims else f"{name}_clean",
            "staging": f"stg_{name}",
            "measures": measures,
            "dims": dims,
            "keeps": keeps,
        },
    }


def _q(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def build_tasks(name: str, source: dict, steps: list, model: dict, catalog: str) -> list | None:
    """Compose the approved plan into workflow tasks (the load itself).

    Only steps the user approved arrive here; the SQL is deterministic from
    them. Returns None when the source or an identifier fails validation.
    """
    frm = source_expr(source)
    if frm is None or not IDENT.match(name):
        return None

    renames = {s["column"]: s["to"] for s in steps if s.get("kind") == "rename"}
    casts = {s["column"]: s["to_type"] for s in steps if s.get("kind") == "cast"}
    drop_cols = {s["column"] for s in steps if s.get("kind") == "drop_column"}
    null_filters = [s["column"] for s in steps if s.get("kind") == "drop_null_rows"]
    dedupe = any(s.get("kind") == "dedupe" for s in steps)

    # An approved drop wins over the model: staging omits the column, so the
    # fact/dim SQL must never reference its final name (the UI can edit the
    # model independently of the steps — reconcile here, defensively).
    dropped_final = {renames.get(c, c) for c in drop_cols}
    model = {
        **model,
        "measures": [m for m in model.get("measures") or [] if m not in dropped_final],
        "keeps": [k for k in model.get("keeps") or [] if k not in dropped_final],
        "dims": [d for d in model.get("dims") or [] if d.get("column") not in dropped_final],
    }

    exprs = []
    for col in _source_columns(steps, model, renames):
        if col in drop_cols:
            continue
        final = renames.get(col, col)
        if col in casts:
            exprs.append(f"TRY_CAST({_q(col)} AS {casts[col]}) AS {_q(final)}")
        elif final != col:
            exprs.append(f"{_q(col)} AS {_q(final)}")
        else:
            exprs.append(_q(col))
    select = "SELECT " + ("DISTINCT " if dedupe else "") + (", ".join(exprs) or "*")
    where = ""
    if null_filters:
        where = " WHERE " + " AND ".join(f"{_q(c)} IS NOT NULL" for c in null_filters)

    staging = model.get("staging") or f"stg_{name}"
    if not IDENT.match(staging):
        return None
    tasks = [
        {
            "id": "stage",
            "task_type": "sql",
            "payload": f"CREATE OR REPLACE TABLE {_q(staging)} AS {select} FROM {frm}{where};",
            "catalog": catalog,
        }
    ]

    dims = model.get("dims") or []
    for d in dims:
        col, table = d.get("column", ""), d.get("table", "")
        if not (IDENT.match(col) and IDENT.match(table)):
            return None
        tasks.append(
            {
                "id": table,
                "task_type": "sql",
                "payload": (
                    f"CREATE OR REPLACE TABLE {_q(table)} AS "
                    f"SELECT row_number() OVER (ORDER BY {_q(col)}) AS {_q(col + '_id')}, {_q(col)} "
                    f"FROM (SELECT DISTINCT {_q(col)} FROM {_q(staging)} "
                    f"WHERE {_q(col)} IS NOT NULL) t;"
                ),
                "catalog": catalog,
                "depends_on": ["stage"],
            }
        )

    fact = model.get("fact") or f"fact_{name}"
    if not IDENT.match(fact):
        return None
    if dims:
        cols = [f"s.{_q(c)}" for c in (model.get("measures") or []) + (model.get("keeps") or [])]
        joins = []
        for i, d in enumerate(dims):
            col = d["column"]
            cols.append(f"d{i}.{_q(col + '_id')}")
            joins.append(f"LEFT JOIN {_q(d['table'])} d{i} USING ({_q(col)})")
        tasks.append(
            {
                "id": "fact",
                "task_type": "sql",
                "payload": (
                    f"CREATE OR REPLACE TABLE {_q(fact)} AS "
                    f"SELECT {', '.join(cols)} FROM {_q(staging)} s " + " ".join(joins) + ";"
                ),
                "catalog": catalog,
                "depends_on": [d["table"] for d in dims],
            }
        )
    else:
        tasks.append(
            {
                "id": "publish",
                "task_type": "sql",
                "payload": f"CREATE OR REPLACE TABLE {_q(fact)} AS SELECT * FROM {_q(staging)};",
                "catalog": catalog,
                "depends_on": ["stage"],
            }
        )
    return tasks


def _source_columns(steps: list, model: dict, renames: dict) -> list:
    """Original column order, reconstructed from the model + step metadata.

    The model carries FINAL names; steps carry originals. Invert the renames
    so the staging SELECT reads source columns and writes final ones.
    """
    inverse = {v: k for k, v in renames.items()}
    ordered = []
    for final in (model.get("measures") or []) + [d["column"] for d in (model.get("dims") or [])] + (
        model.get("keeps") or []
    ):
        ordered.append(inverse.get(final, final))
    # columns being dropped never made it into the model but still need no
    # SELECT entry; columns only referenced by null-filters are in the model
    return ordered
