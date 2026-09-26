import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { FormMessage, selectStyle } from "./Form";

/*
 * Who may open sessions on an engine: "everyone" or "group:<name>". Admins get
 * a select that POSTs immediately; everyone else sees the current value.
 */

export function accessLabel(access: string | undefined): string {
  if (!access || access === "everyone") return "Everyone";
  return access.startsWith("group:") ? `Group: ${access.slice("group:".length)}` : access;
}

/** Group names for the access select; null until loaded. */
export function useGroupNames(enabled: boolean): string[] | null {
  const [names, setNames] = useState<string[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    api
      .get<{ name: string }[]>("/groups")
      .then((g) => setNames(g.map((x) => x.name)))
      // The select still offers "Everyone" and the current value without it.
      .catch(() => setNames([]));
  }, [enabled]);
  return names;
}

export function EngineAccess({
  engine,
  access,
  admin,
  groups,
  onChanged,
}: {
  engine: string;
  access: string | undefined;
  admin: boolean;
  groups: string[] | null;
  onChanged: (access: string) => void;
}) {
  const current = access || "everyone";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!admin) {
    return (
      <span className="mono" style={{ fontSize: "var(--fs-body)" }}>
        {accessLabel(current)}
      </span>
    );
  }

  const options = new Set<string>(["everyone", current]);
  for (const g of groups ?? []) options.add(`group:${g}`);

  const change = (next: string) => {
    if (next === current) return;
    setSaving(true);
    setError("");
    api
      .post(`/engines/${encodeURIComponent(engine)}/access`, { access: next })
      .then(() => onChanged(next))
      .catch((e) => setError(errorText(e)))
      .finally(() => setSaving(false));
  };

  return (
    <div style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      <select
        aria-label={`Access for ${engine}`}
        value={current}
        disabled={saving}
        onChange={(e) => change(e.target.value)}
        style={{ ...selectStyle, opacity: saving ? 0.6 : 1 }}
      >
        {[...options].map((o) => (
          <option key={o} value={o}>
            {saving && o === current ? "Saving…" : accessLabel(o)}
          </option>
        ))}
      </select>
      {error && <FormMessage tone="err">{error}</FormMessage>}
    </div>
  );
}
