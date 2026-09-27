// Notebook paths (Databricks-style workspace). A notebook's name is a relative
// path inside ~/notebooks — `claims-eda`, `projects/hedis/q1-review` — and the
// SPA route is `/notebooks/<path>` (a splat). Every URL built here encodes
// each segment on its own so the slashes stay slashes.
import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "./api";

/** One path segment — the server's rule, mirrored so forms refuse early. */
export const NB_SEGMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Folder levels allowed above the notebook itself. */
export const NB_MAX_DEPTH = 4;
const RESERVED_LEAF = new Set(["ipynb", "cells", "import"]);

/** `a/b c` → `a/b%20c`: encode each segment, keep the separators. */
export const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/** The SPA route of a notebook. */
export const notebookUrl = (path: string) => `/notebooks/${encodePath(path)}`;

/** The /api path of a notebook (prefix `api.get` etc. add `/api`). */
export const notebookApi = (path: string) => `/notebooks/${encodePath(path)}`;

/** `projects/hedis/q1` → `projects/hedis`; `q1` → `""` (the root). */
export const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** `projects/hedis/q1` → `q1`. */
export const leafOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Join a folder ("" = root) and a relative name. */
export const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** How a path reads to a person: `~/notebooks/projects/hedis`. */
export const displayFolder = (folder: string) => (folder ? `~/notebooks/${folder}` : "~/notebooks");

/**
 * Why `path` is not an acceptable notebook (or folder) path, or "" when it is.
 * `folder` paths skip the reserved-leaf rule and allow one more level.
 */
export function pathProblem(path: string, kind: "notebook" | "folder" = "notebook"): string {
  const segs = path.split("/");
  if (segs.some((s) => !NB_SEGMENT.test(s))) {
    return "Use lower-case letters, digits, dash or underscore (max 64) in each part; separate folders with /.";
  }
  const folders = kind === "notebook" ? segs.length - 1 : segs.length;
  if (folders > NB_MAX_DEPTH) return `At most ${NB_MAX_DEPTH} folder levels.`;
  if (kind === "notebook" && RESERVED_LEAF.has(segs[segs.length - 1])) {
    return `A notebook can't be called “${segs[segs.length - 1]}”.`;
  }
  return "";
}

export interface NotebookTree {
  folders: string[];
  notebooks: string[];
}

/**
 * Loads GET /api/notebooks/tree. `tree` stays null on failure — an unreadable
 * home is not an empty workspace (REQ-49). `reload` re-reads it.
 */
export function useNotebookTree(): { tree: NotebookTree | null; error: string; reload: () => void } {
  const [tree, setTree] = useState<NotebookTree | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    api
      .get<NotebookTree>("/notebooks/tree")
      .then((t) => {
        setTree({ folders: t.folders ?? [], notebooks: t.notebooks ?? [] });
        setError("");
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(reload, [reload]);
  return { tree, error, reload };
}
