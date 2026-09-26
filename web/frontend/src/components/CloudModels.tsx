import type { CSSProperties } from "react";

/*
 * The honest counterpart to "No data leaves your hosts": when any configured
 * Nkoyo model runs on Ollama's cloud (GET /api/nkoyo/config → cloud_models),
 * prompts and tool results do leave the cluster, and the UI must say so.
 */
export function CloudModelsWarning({ models, style }: { models: string[]; style?: CSSProperties }) {
  return (
    <div
      role="note"
      style={{
        background: "var(--warn-tint)",
        color: "var(--warn)",
        border: "1px solid var(--warn)",
        borderRadius: 10,
        padding: "8px 10px",
        fontSize: 11.5,
        lineHeight: 1.5,
        overflowWrap: "break-word",
        ...style,
      }}
    >
      Using cloud models (<span className="mono">{models.join(", ")}</span>) — prompts and tool
      results are sent to ollama.com.
    </div>
  );
}
