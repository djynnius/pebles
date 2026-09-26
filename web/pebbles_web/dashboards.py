"""Dashboard documents: tile kinds, filters, and safe filter substitution.

A dashboard is `{catalog, filters: [{name, label, default}], tiles: [{title,
sql, kind}]}`. Tiles reference filters as `{{name}}` in their SQL; values are
substituted as QUOTED, ESCAPED SQL string literals — a filter value is data
and can never alter the query's structure (write `CAST({{year}} AS INT)` or
compare as text). Tiles always run as the viewing user, so a filter can't
widen access either.
"""

import re

TILE_KINDS = ("table", "stat", "bars", "line", "donut")
FILTER_NAME = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
PLACEHOLDER = re.compile(r"\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}")
MAX_FILTERS = 8
MAX_FILTER_VALUE = 200


def sanitize(dash: dict) -> dict:
    filters = []
    for f in dash.get("filters", [])[:MAX_FILTERS]:
        if isinstance(f, dict) and FILTER_NAME.match(str(f.get("name", ""))):
            filters.append({
                "name": f["name"],
                "label": str(f.get("label") or f["name"])[:40],
                "default": str(f.get("default") or "")[:MAX_FILTER_VALUE],
            })
    return {
        "catalog": dash.get("catalog") or None,
        "filters": filters,
        "tiles": [
            {
                "title": str(t.get("title", ""))[:80],
                "sql": str(t.get("sql", "")),
                "kind": t.get("kind", "table"),
            }
            for t in dash.get("tiles", [])
            if isinstance(t, dict) and t.get("kind", "table") in TILE_KINDS
        ],
    }


def sql_literal(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def apply_filters(sql: str, filters: list, values: dict) -> str:
    """Replace every {{name}} with the chosen (or default) value as a literal.
    Unknown placeholders are left alone so the SQL error names them."""
    known = {f["name"]: f.get("default", "") for f in filters}

    def sub(m):
        name = m.group(1)
        if name not in known:
            return m.group(0)
        raw = values.get(name, known[name])
        return sql_literal(str(raw)[:MAX_FILTER_VALUE])

    return PLACEHOLDER.sub(sub, sql)
