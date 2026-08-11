export function Wordmark({ size = 18 }: { size?: number }) {
  return (
    <span
      style={{
        fontFamily: "'Cascadia Code', 'JetBrains Mono', 'IBM Plex Mono', monospace",
        fontWeight: 700,
        fontSize: size,
        letterSpacing: size > 40 ? "-2px" : "-0.5px",
        color: "var(--deep-text)",
      }}
    >
      pe<span style={{ color: "var(--accent)" }}>{"{"}</span>b
      <span style={{ color: "var(--accent)" }}>{"}"}</span>les
    </span>
  );
}
