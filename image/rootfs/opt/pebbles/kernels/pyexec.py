"""Persistent Python cell executor.

Spawned lazily by sql-runner (so it inherits the SESSION USER's uid and home) and
kept alive for the session: globals persist across cells, like a notebook expects.
Protocol: one JSON request line in ({"code": ...}), one JSON response line out
({"ok", "stdout", "stderr", "error", "images", "table"}). The last expression of
a cell echoes its repr, notebook-style — except DataFrames, which come back as a
structured `table` (data, never HTML), and matplotlib figures, which come back
as base64 PNGs in `images`.
"""

import ast
import base64
import contextlib
import io
import json
import os
import sys
import traceback

# Headless: figures render to memory, never to a display.
os.environ.setdefault("MPLBACKEND", "Agg")

MAX_STDOUT = 65536
MAX_STDERR = 16384
MAX_TABLE_ROWS = 200
MAX_IMAGES = 8
MAX_IMAGE_BYTES = 2_000_000


def as_table(value):
    """A pandas/polars DataFrame or Series as {columns, rows, total}; else None."""
    try:
        if type(value).__module__.startswith("polars") and hasattr(value, "to_pandas"):
            value = value.to_pandas()
        mod = type(value).__module__
        if not mod.startswith("pandas"):
            return None
        import pandas as pd  # already imported by the user if we got here

        if isinstance(value, pd.Series):
            value = value.to_frame()
        if not isinstance(value, pd.DataFrame):
            return None
        total = len(value)
        head = value.head(MAX_TABLE_ROWS)
        if not isinstance(head.index, pd.RangeIndex):
            head = head.reset_index()
        split = json.loads(
            head.to_json(orient="split", date_format="iso", default_handler=str)
        )
        cols = [str(c) for c in split["columns"]]
        return {
            "columns": cols,
            "rows": [dict(zip(cols, r)) for r in split["data"]],
            "total": total,
            "truncated": total > MAX_TABLE_ROWS,
        }
    except Exception:  # never let rendering break the cell
        return None


def take_figures():
    """Every open matplotlib figure as base64 PNG, then close them all."""
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    images = []
    try:
        for num in plt.get_fignums()[:MAX_IMAGES]:
            buf = io.BytesIO()
            plt.figure(num).savefig(buf, format="png", dpi=100, bbox_inches="tight")
            if buf.tell() <= MAX_IMAGE_BYTES:
                images.append(base64.b64encode(buf.getvalue()).decode("ascii"))
        plt.close("all")
    except Exception:
        pass
    return images


cell_globals = {"__name__": "__main__"}

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        request = json.loads(line)
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "error": f"bad request: {exc}"}), flush=True)
        continue

    code = request.get("code", "")
    out, err = io.StringIO(), io.StringIO()
    ok, error = True, None
    table = None
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            tree = ast.parse(code, mode="exec")
            trailing = None
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                trailing = ast.Expression(tree.body.pop(-1).value)
            exec(compile(tree, "<cell>", "exec"), cell_globals)  # noqa: S102
            if trailing is not None:
                value = eval(compile(trailing, "<cell>", "eval"), cell_globals)  # noqa: S307
                if value is not None:
                    table = as_table(value)
                    if table is None:
                        print(repr(value))
    except BaseException:  # a cell may raise anything; the session must survive
        ok, error = False, traceback.format_exc(limit=20)

    print(
        json.dumps(
            {
                "ok": ok,
                "stdout": out.getvalue()[-MAX_STDOUT:],
                "stderr": err.getvalue()[-MAX_STDERR:],
                "error": error,
                "images": take_figures(),
                "table": table,
            }
        ),
        flush=True,
    )
