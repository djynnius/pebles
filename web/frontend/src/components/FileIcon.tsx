/*
 * Row icons for the Files browser, chosen from the item's kind and extension.
 * Inline SVG on currentColor; each kind takes its tint from a theme token.
 */

export type FileKind = "folder" | "python" | "r" | "notebook" | "json" | "table" | "file";

/** Picks the icon kind. `path` is home-relative, used for notebooks/*.json. */
export function fileKind(name: string, dir: boolean, path = ""): FileKind {
  if (dir) return "folder";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : "";
  const lower = ext.toLowerCase();
  if (lower === "py") return "python";
  if (lower === "r") return "r";
  if (lower === "ipynb") return "notebook";
  if (lower === "json") {
    return path.split("/").includes("notebooks") ? "notebook" : "json";
  }
  if (lower === "csv" || lower === "tsv" || lower === "parquet") return "table";
  return "file";
}

const TINT: Record<FileKind, string> = {
  folder: "var(--viz-4)",
  python: "var(--viz-5)",
  r: "var(--viz-2)",
  notebook: "var(--accent)",
  json: "var(--viz-3)",
  table: "var(--ok-ink)",
  file: "var(--text-faint)",
};

const LABEL: Record<FileKind, string> = {
  folder: "Folder",
  python: "Python file",
  r: "R file",
  notebook: "Notebook",
  json: "JSON file",
  table: "Data file",
  file: "File",
};

export function FileIcon({ kind, size = 16 }: { kind: FileKind; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      strokeLinecap="round"
      role="img"
      aria-label={LABEL[kind]}
      style={{ color: TINT[kind], flexShrink: 0, display: "block" }}
    >
      {kind === "folder" ? (
        <path d="M1.8 4.2c0-.6.4-1 1-1h3.4l1.4 1.5h5.6c.6 0 1 .4 1 1v6.9c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1Z" />
      ) : kind === "table" ? (
        <>
          <rect x="2" y="2.5" width="12" height="11" rx="1.3" />
          <path d="M2 6.2h12M2 9.8h12M6.2 2.5v11M10.1 2.5v11" />
        </>
      ) : (
        <>
          <path d="M3.5 1.8h6l3 3v9.4H3.5Z" />
          <path d="M9.5 1.8v3h3" />
          {kind === "python" && <Tag text="py" />}
          {kind === "r" && <Tag text="R" />}
          {kind === "json" && <Tag text="{}" />}
          {kind === "notebook" && <path d="M5.6 8.2h4.8M5.6 10.3h4.8M5.6 12.3h3" />}
        </>
      )}
    </svg>
  );
}

function Tag({ text }: { text: string }) {
  return (
    <text
      x="8"
      y="12.4"
      textAnchor="middle"
      fontSize={text.length > 1 ? 5.4 : 6.4}
      fontWeight="700"
      fontFamily="'IBM Plex Mono', monospace"
      fill="currentColor"
      stroke="none"
    >
      {text}
    </text>
  );
}
