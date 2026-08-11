// Nkoyo's avatar: a charcoal silhouette in profile inside an accent ring (spec
// §4). The prototype embeds a PNG; this is a faithful inline-SVG silhouette so
// the bundle stays lean and fully offline.
export function NkoyoAvatar({ size = 32 }: { size?: number }) {
  const pad = Math.max(2, Math.round(size / 16));
  return (
    <span
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        background: "var(--accent)",
        padding: pad,
      }}
    >
      <span
        style={{
          width: "100%",
          height: "100%",
          borderRadius: "50%",
          overflow: "hidden",
          border: "2px solid var(--surface)",
          background: "#f4ecdf",
          display: "grid",
          placeItems: "center",
        }}
      >
        <svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden>
          {/* profile silhouette facing left, afro */}
          <path
            fill="#33342c"
            d="M44 58c0-9-5-13-12-15 6-1 11-6 11-14 0-4-2-7-2-9 2-1 3-3 3-6 0-6-6-11-15-11-11 0-19 7-19 18 0 6 2 10 5 13-2 2-3 5-3 9v15h31z"
          />
        </svg>
      </span>
    </span>
  );
}
