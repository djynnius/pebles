"""The engine-side Excel cleaner (image/rootfs/opt/pebbles/etl/tabular_import.py)."""

# Excel cell dates are timezone-naive by nature.
# ruff: noqa: DTZ001

import datetime as dt
import importlib.util
import json
import pathlib

import pytest

openpyxl = pytest.importorskip("openpyxl")
pytest.importorskip("duckdb")
pytest.importorskip("pandas")

SCRIPT = (
    pathlib.Path(__file__).resolve().parents[2]
    / "image/rootfs/opt/pebbles/etl/tabular_import.py"
)
spec = importlib.util.spec_from_file_location("tabular_import", SCRIPT)
ti = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ti)


def messy_rows():
    return [
        ["ACME Health — Claims report", None, None, None, None],
        ["Generated 2026-09-01", None, None, None, None],
        [None, None, None, None, None],
        ["Claim ID", "State", "Filed", "Amount ($)", None],
        [1, "CA", dt.datetime(2025, 1, 2), "1,200.50", None],
        [2, "NY", dt.datetime(2025, 1, 3), 80, None],
        [None, None, None, None, None],
        ["Claim ID", "State", "Filed", "Amount ($)", None],  # page-break header
        [3, "CA", dt.datetime(2025, 2, 1), "(15)", None],
        ["Total", None, None, 1265.5, None],
        ["Source: internal warehouse, see notes tab", None, None, None, None],
        [None, None, None, None, None],
    ]


def test_clean_sheet_finds_header_and_drops_non_data_rows():
    out = ti.clean_sheet(messy_rows())
    assert out["columns"] == ["claim_id", "state", "filed", "amount"]
    assert [r[0] for r in out["data"]] == [1, 2, 3]
    assert [r[3] for r in out["data"]] == [1200.5, 80.0, -15.0]  # "1,200.50", "(15)"
    assert isinstance(out["data"][0][2], dt.datetime)
    notes = " | ".join(out["cleaning"])
    for expected in (
        "1 empty column",
        "2 title row(s)",
        "1 blank row(s)",  # the interior blank, not trailing padding
        "1 repeated header",
        "1 total/subtotal",
        "1 note row",
    ):
        assert expected in notes, notes
    assert not out["empty"]


def test_headerless_and_empty_sheets():
    numbers = ti.clean_sheet([[1, 2], [3, 4]])
    assert numbers["columns"] == ["column_1", "column_2"]
    assert numbers["data"] == [[1, 2], [3, 4]]
    assert ti.clean_sheet([[None, None], [None]])["empty"] is True


def test_duplicate_and_blank_headers_get_unique_names():
    out = ti.clean_sheet([["Name", "Name", None, "2024"], ["a", "b", "c", 1]])
    assert out["columns"] == ["name", "name_2", "column_3", "c_2024"]


def test_inspect_stages_every_sheet_as_parquet(tmp_path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Q1 Sales"
    for row in messy_rows():
        ws.append(row)
    wb.create_sheet("Notes").append(["just words"])
    wb.create_sheet("Blank")
    book = tmp_path / "sales.xlsx"
    wb.save(book)

    stage = tmp_path / "stage"
    result = ti.inspect(str(book), str(stage))
    by_key = {t["key"]: t for t in result["tables"]}
    q1 = by_key["Q1 Sales"]
    assert q1["name"] == "q1_sales" and q1["rows"] == 3 and not q1["empty"]
    types = {c["name"]: c["type"] for c in q1["columns"]}
    assert types["claim_id"] == "BIGINT" and types["amount"] == "DOUBLE"
    assert types["filed"].startswith("TIMESTAMP") and types["state"] == "VARCHAR"
    assert q1["preview"][0]["state"] == "CA"
    assert by_key["Blank"]["empty"] is True

    manifest = json.loads((stage / "manifest.json").read_text())
    import duckdb

    staged = manifest["sheets"]["Q1 Sales"]
    assert duckdb.sql(f"SELECT count(*) FROM read_parquet('{staged}')").fetchone()[0] == 3
    assert "Blank" not in manifest["sheets"]


def test_cli_reports_errors_as_json(tmp_path, capsys):
    assert ti.main(["x", "inspect", str(tmp_path / "missing.xlsx"), str(tmp_path / "s")]) == 1
    assert "error" in json.loads(capsys.readouterr().out)
