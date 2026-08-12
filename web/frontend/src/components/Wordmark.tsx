// The pebbles wordmark: p{b|es. Per-character colours are brand-fixed
// (green p, orange b, pink es); the brace and pipe take the surface's
// foreground so the mark stays legible on dark rails and light pages alike.
export function Wordmark({
  size = 18,
  tone = "deep",
}: {
  size?: number;
  /** "deep" = light-on-dark surfaces (rail, login panel, mobile gate);
   *  "surface" = normal page background. */
  tone?: "deep" | "surface";
}) {
  const ink = tone === "deep" ? "var(--deep-text)" : "var(--text)";
  return (
    <span
      style={{
        fontFamily: "'Cascadia Code', 'JetBrains Mono', 'IBM Plex Mono', monospace",
        fontWeight: 700,
        fontSize: size,
        letterSpacing: "-0.04em",
        color: ink,
      }}
    >
      <span style={{ color: "var(--brand-p)" }}>p</span>
      {"{"}
      <span style={{ color: "var(--brand-b)" }}>b</span>
      {"|"}
      <span style={{ color: "var(--accent)" }}>es</span>
    </span>
  );
}
