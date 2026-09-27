"""Excel → clean tables, for "+ New → Table" and Catalog "Upload table…".

Runs on the engine AS THE USER (one-shot, through their session's shell op),
with the image's pebbles conda env: pandas + openpyxl read the workbook, the
bundled duckdb module stages each cleaned sheet as Parquet (there is no
pyarrow), and the web tier then loads the Parquet into the lake with
CREATE TABLE … AS SELECT * FROM read_parquet(…).

    python tabular_import.py inspect <workbook.xlsx> <stage-dir>

prints one JSON document on stdout: {"tables": [...]} (see `inspect`), and
leaves <stage-dir>/<n>.parquet plus <stage-dir>/manifest.json behind.

Spreadsheets are made for people, not loaders: a title and a blank line above
the header, notes and a TOTAL row below, a header repeated on page breaks,
empty spacer columns. `clean_sheet` finds the header row and drops everything
that is not a data row, saying what it dropped.
"""

import datetime as _dt
import json
import os
import re
import sys

#: rows scanned for the header
HEADER_SCAN = 25
#: share of a column's values that must parse for it to become numeric/date
TYPE_RATIO = 0.95
#: preview rows returned to the UI
PREVIEW_ROWS = 5
TOTAL_ROW = re.compile(r"^\s*(grand\s+|sub\s*-?\s*)?totals?\b", re.IGNORECASE)


def snake(name: str) -> str:
    out = re.sub(r"[^A-Za-z0-9]+", "_", str(name).strip())
    out = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", out).lower()
    out = re.sub(r"_+", "_", out).strip("_")
    if out and out[0].isdigit():
        out = f"c_{out}"
    return out


def _blank(v) -> bool:
    if v is None:
        return True
    if isinstance(v, float) and v != v:  # NaN
        return True
    return isinstance(v, str) and not v.strip()


def _cells(row) -> list:
    return [v for v in row if not _blank(v)]


def _header_index(rows: list, width: int) -> int | None:
    """First row (within HEADER_SCAN) that is wide enough and mostly text."""
    need = 1 if width <= 1 else max(2, int(0.6 * width + 0.5))
    for i, row in enumerate(rows[:HEADER_SCAN]):
        filled = _cells(row)
        if len(filled) < need:
            continue
        text = sum(isinstance(v, str) for v in filled)
        if text >= 0.6 * len(filled):
            return i
    return None


def _column_names(header: list) -> tuple[list, int]:
    names, seen, renamed = [], {}, 0
    for i, raw in enumerate(header):
        base = snake(raw) if not _blank(raw) else ""
        if not base:
            base = f"column_{i + 1}"
        if base != (str(raw).strip() if not _blank(raw) else None):
            renamed += 1
        n = seen.get(base, 0)
        seen[base] = n + 1
        names.append(base if n == 0 else f"{base}_{n + 1}")
    return names, renamed


def _typed(values: list) -> list:
    """Column values → numbers, datetimes or strings (None for blanks)."""
    present = [v for v in values if not _blank(v)]
    if not present:
        return [None] * len(values)

    def as_number(v):
        if isinstance(v, bool):
            return None
        if isinstance(v, (int, float)):
            return v
        if isinstance(v, str):
            s = v.strip().replace(",", "")
            if s.endswith("%"):
                return None
            if s.startswith("(") and s.endswith(")"):  # accounting negative
                s = "-" + s[1:-1]
            s = s.lstrip("$£€")
            try:
                return float(s) if re.search(r"[.eE]", s) else int(s)
            except ValueError:
                return None
        return None

    numbers = [as_number(v) for v in present]
    if sum(n is not None for n in numbers) >= TYPE_RATIO * len(present):
        out = []
        for v in values:
            n = None if _blank(v) else as_number(v)
            out.append(n)
        if all(isinstance(n, int) or n is None or float(n).is_integer() for n in out):
            return [None if n is None else int(n) for n in out]
        return [None if n is None else float(n) for n in out]

    dates = [v for v in present if isinstance(v, (_dt.datetime, _dt.date))]
    if len(dates) >= TYPE_RATIO * len(present):
        return [v if isinstance(v, (_dt.datetime, _dt.date)) else None for v in values]

    return [None if _blank(v) else str(v).strip() for v in values]


def clean_sheet(rows: list) -> dict:
    """rows: the sheet as a list of lists (header=None). Returns
    {"columns": [names], "data": [[...]], "cleaning": [notes], "empty": bool}."""
    notes = []
    width_all = max((len(r) for r in rows), default=0)
    rows = [list(r) + [None] * (width_all - len(r)) for r in rows]

    # empty spacer columns
    keep_cols = [c for c in range(width_all) if any(not _blank(r[c]) for r in rows)]
    if len(keep_cols) < width_all:
        notes.append(f"dropped {width_all - len(keep_cols)} empty column(s)")
    rows = [[r[c] for c in keep_cols] for r in rows]

    nonblank = [r for r in rows if _cells(r)]
    if not nonblank:
        return {"columns": [], "data": [], "cleaning": ["the sheet is empty"], "empty": True}
    width = max(len(_cells(r)) for r in nonblank)

    h = _header_index(rows, width)
    if h is None:
        header = [None] * len(keep_cols)
        body = rows
        notes.append("no header row found — columns are numbered")
    else:
        header, body = rows[h], rows[h + 1 :]
        titles = sum(1 for r in rows[:h] if _cells(r))
        if titles:
            notes.append(f"dropped {titles} title row(s) above the header")

    columns, renamed = _column_names(header)
    if renamed and h is not None:
        notes.append(f"renamed {renamed} column(s) to lowercase_with_underscores")

    header_text = [str(v).strip().lower() for v in header if not _blank(v)]
    data, blank, pending, repeated, totals, note_rows = [], 0, 0, 0, 0, 0
    for r in body:
        filled = _cells(r)
        if not filled:
            pending += 1  # only counts if more rows follow (not sheet padding)
            continue
        blank, pending = blank + pending, 0
        if h is not None and [str(v).strip().lower() for v in filled] == header_text:
            repeated += 1
            continue
        first = next(iter(filled))
        if isinstance(first, str) and TOTAL_ROW.match(first):
            totals += 1
            continue
        if len(filled) == 1 and width >= 3 and isinstance(first, str):
            note_rows += 1
            continue
        data.append(r)
    for count, what in (
        (blank, "blank row(s)"),
        (repeated, "repeated header row(s)"),
        (totals, "total/subtotal row(s)"),
        (note_rows, "note row(s)"),
    ):
        if count:
            notes.append(f"dropped {count} {what}")

    if not data:
        return {"columns": columns, "data": [], "cleaning": notes + ["no data rows"], "empty": True}
    by_col = list(zip(*data))
    typed_cols = [_typed(list(col)) for col in by_col]
    typed_rows = [list(r) for r in zip(*typed_cols)]
    return {"columns": columns, "data": typed_rows, "cleaning": notes, "empty": False}


def _stage(con, table: dict, target: str) -> list:
    """Write the cleaned rows to Parquet with duckdb; returns [{name, type}]."""
    import pandas as pd

    df = pd.DataFrame(table["data"], columns=table["columns"])
    for col in df.columns:  # object columns of ints/floats → proper dtypes
        if df[col].dtype == object:
            sample = df[col].dropna()
            if len(sample) and all(isinstance(v, str) for v in sample):
                df[col] = df[col].astype("string")
    con.register("sheet_df", df)
    try:
        con.execute(f"COPY (SELECT * FROM sheet_df) TO '{target}' (FORMAT parquet)")
        described = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{target}')").fetchall()
    finally:
        con.unregister("sheet_df")
    return [{"name": r[0], "type": r[1]} for r in described]


def _jsonable(v):
    if isinstance(v, (_dt.datetime, _dt.date)):
        return v.isoformat()
    return v


def inspect(path: str, stage_dir: str) -> dict:
    import duckdb
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    os.makedirs(stage_dir, exist_ok=True)
    con = duckdb.connect()
    tables, manifest = [], {}
    try:
        for i, ws in enumerate(wb.worksheets):
            rows = [list(r) for r in ws.iter_rows(values_only=True)]
            cleaned = clean_sheet(rows)
            entry = {
                "key": ws.title,
                "name": snake(ws.title) or f"sheet_{i + 1}",
                "rows": len(cleaned["data"]),
                "columns": [{"name": c, "type": "VARCHAR"} for c in cleaned["columns"]],
                "preview": [
                    {c: _jsonable(v) for c, v in zip(cleaned["columns"], r)}
                    for r in cleaned["data"][:PREVIEW_ROWS]
                ],
                "cleaning": cleaned["cleaning"],
                "empty": cleaned["empty"],
            }
            if not cleaned["empty"]:
                target = os.path.join(stage_dir, f"{i}.parquet")
                entry["columns"] = _stage(con, cleaned, target)
                manifest[ws.title] = target
            tables.append(entry)
    finally:
        con.close()
        wb.close()
    with open(os.path.join(stage_dir, "manifest.json"), "w") as f:
        json.dump({"source": os.path.abspath(path), "sheets": manifest}, f)
    return {"tables": tables}


def main(argv: list) -> int:
    if len(argv) != 4 or argv[1] != "inspect":
        print(json.dumps({"error": "usage: tabular_import.py inspect <xlsx> <stage-dir>"}))
        return 2
    try:
        result = inspect(argv[2], argv[3])
    except Exception as exc:  # noqa: BLE001 — report any reader failure to the UI
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}))
        return 1
    print(json.dumps(result, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
