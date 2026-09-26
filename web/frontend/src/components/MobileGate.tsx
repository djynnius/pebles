import { Wordmark } from "./Wordmark";
import { APP_VERSION } from "../version";

// The 699px mobile gate (spec §3): below 700px the whole app is replaced. Not a
// mobile product by design (PRD non-goal).
export function MobileGate() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--deep)",
        color: "var(--deep-text)",
        padding: "36px 28px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 18,
      }}
    >
      <Wordmark size={40} />
      <h1 style={{ fontSize: "var(--fs-h2)", fontWeight: 700 }}>Pebbles needs a bigger screen.</h1>
      <p style={{ color: "var(--deep-muted)", maxWidth: 340, lineHeight: 1.7 }}>
        Pebbles is a desktop workspace — lakes, notebooks, and pipelines want room
        to breathe. Open it on a laptop or larger display.
      </p>
      <p className="mono" style={{ fontSize: "var(--fs-label)", color: "var(--deep-faint)", marginTop: 12 }}>
        v{APP_VERSION} · self-hosted
      </p>
    </div>
  );
}
