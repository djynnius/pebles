"""Notebook documents: sanitizing and Jupyter (.ipynb) interop.

A Pebbles notebook is `{catalog, cells: [{type, source, outputs?}]}` in the
user's home. Cell types: sql | python | r | md (markdown never executes).
Outputs are what the last run produced — saved with the document so reopening
a notebook shows its results, capped so one huge result can't bloat the file.

Jupyter interop is lossless in the directions that matter: python and
markdown cells map 1:1; SQL and R cells become code cells carrying a
`%%sql` / `%%R` cell magic (the conventional way Jupyter spells them), so an
export → import round trip restores their type.
"""

import json

CELL_TYPES = ("sql", "python", "r", "md")
#: total serialized size of saved outputs per notebook
MAX_OUTPUT_BYTES = 2_000_000
#: fields a saved output may carry (anything else from the client is dropped)
OUTPUT_FIELDS = ("ok", "rows", "stdout", "stderr", "error", "images", "table", "truncated")


def _clean_output(out) -> dict | None:
    if not isinstance(out, dict):
        return None
    kept = {k: out[k] for k in OUTPUT_FIELDS if k in out}
    return kept or None


def sanitize(nb: dict) -> dict:
    cells, budget = [], MAX_OUTPUT_BYTES
    for c in nb.get("cells", []):
        if not isinstance(c, dict) or c.get("type", "sql") not in CELL_TYPES:
            continue
        cell = {"type": c.get("type", "sql"), "source": str(c.get("source", ""))}
        out = _clean_output(c.get("output")) if cell["type"] != "md" else None
        if out is not None:
            size = len(json.dumps(out))
            if size <= budget:
                cell["output"] = out
                budget -= size
            else:
                cell["output"] = {"ok": True, "stdout": "(output too large to save — run again)"}
        cells.append(cell)
    return {"catalog": nb.get("catalog") or None, "cells": cells}


def _lines(text: str) -> list:
    return text.splitlines(keepends=True)


MAGIC = {"sql": "%%sql", "r": "%%R"}


def to_ipynb(nb: dict) -> dict:
    """nbformat 4.5; outputs are omitted (a clean notebook is the portable form)."""
    cells = []
    for i, c in enumerate(nb.get("cells", [])):
        kind, src = c.get("type", "sql"), c.get("source", "")
        if kind == "md":
            cells.append({"cell_type": "markdown", "id": f"c{i}", "metadata": {},
                          "source": _lines(src)})
            continue
        body = src if kind == "python" else f"{MAGIC[kind]}\n{src}"
        cells.append({"cell_type": "code", "id": f"c{i}", "metadata": {},
                      "execution_count": None, "outputs": [], "source": _lines(body)})
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"},
            "language_info": {"name": "python"},
            "pebbles": {"catalog": nb.get("catalog")},
        },
        "cells": cells,
    }


def from_ipynb(doc: dict) -> dict:
    """Code cells → python (or sql/r by their magic); markdown → md; raw dropped."""
    if not isinstance(doc, dict) or not isinstance(doc.get("cells"), list):
        # malformed upload content, not a programming error: callers map it to 422
        raise ValueError("not a Jupyter notebook (no cells)")  # noqa: TRY004
    cells = []
    for c in doc["cells"]:
        src = c.get("source", "")
        src = "".join(src) if isinstance(src, list) else str(src)
        if c.get("cell_type") == "markdown":
            cells.append({"type": "md", "source": src})
        elif c.get("cell_type") == "code":
            first, _, rest = src.partition("\n")
            magic = first.strip().lower()
            if magic == "%%sql":
                cells.append({"type": "sql", "source": rest})
            elif magic == "%%r":
                cells.append({"type": "r", "source": rest})
            else:
                cells.append({"type": "python", "source": src})
    catalog = (doc.get("metadata", {}).get("pebbles") or {}).get("catalog")
    return {"catalog": catalog, "cells": cells or [{"type": "sql", "source": ""}]}
