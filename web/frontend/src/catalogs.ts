// Shapes and loaders shared by the Catalog browser, the SQL editor's catalog
// panel, and the Create-catalog form. The backend browses the lake *as the
// signed-in user* (web/pebbles_web/api.py), so everything here is already
// permission-filtered — there is no client-side visibility logic.

import { useEffect, useState } from "react";
import { api, type Row } from "./api";

export interface Catalog {
  name: string;
  owner: string;
  database: string;
  data_path: string;
  /** Only present on the create response (REQ-25: form and SQL are one op). */
  sql?: string;
}

export interface SchemaNode {
  name: string;
  tables: string[];
}

export interface TreeResponse {
  schemas: SchemaNode[];
}

export interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

export interface TableDetail {
  columns: ColumnInfo[];
  row_count: number | null;
  sample: Row[];
  snapshots: Row[];
}

export interface Grant {
  group: string;
}

export interface Group {
  name: string;
  gid: number;
  members: string[];
}

export interface Engine {
  name: string;
  address: string;
  state: string;
  sessions: number;
  resources: { cpus: number; memory_bytes: number };
}

/** `catalog.schema.table`, quoted so odd identifiers survive a paste. */
export const qualify = (catalog: string, schema: string, table: string) =>
  `"${catalog}"."${schema}"."${table}"`;

/** Loads /api/catalogs once. `null` while in flight. */
export function useCatalogs(): { catalogs: Catalog[] | null; error: string } {
  const [catalogs, setCatalogs] = useState<Catalog[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .get<Catalog[]>("/catalogs")
      .then(setCatalogs)
      .catch((e) => {
        setError(String(e.message ?? e));
        setCatalogs([]);
      });
  }, []);
  return { catalogs, error };
}
