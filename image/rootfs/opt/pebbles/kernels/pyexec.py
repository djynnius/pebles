"""Persistent Python cell executor.

Spawned lazily by sql-runner (so it inherits the SESSION USER's uid and home) and
kept alive for the session: globals persist across cells, like a notebook expects.
Protocol: one JSON request line in ({"code": ...}), one JSON response line out
({"ok", "stdout", "stderr", "error"}). The last expression of a cell echoes its
repr, notebook-style.
"""

import ast
import contextlib
import io
import json
import sys
import traceback

MAX_STDOUT = 65536
MAX_STDERR = 16384

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
            }
        ),
        flush=True,
    )
