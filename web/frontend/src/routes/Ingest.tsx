import { useNavigate } from "react-router-dom";
import { Card, Page } from "../components/Page";

/*
 * /ingest — data ingestion (spec §5 "ingest"). Connectors are a later phase, so
 * this screen is deliberately honest: it names the two routes into the lake that
 * exist today (upload, or query external data in place) and hands off to Auto
 * ETL for the modelling half.
 */

export function Ingest() {
  const nav = useNavigate();
  return (
    <Page
      title="Ingestion"
      eyebrow="Data engineering"
      actions={
        <button
          type="button"
          disabled
          title="Connectors arrive with Auto ETL"
          style={{
            background: "var(--track)",
            color: "var(--text-dim)",
            border: "none",
            borderRadius: 11,
            fontWeight: 600,
            fontSize: "var(--fs-base)",
            padding: "8px 16px",
            cursor: "not-allowed",
          }}
        >
          New connection
        </button>
      }
    >
      <Card style={{ padding: 22, marginBottom: 16 }}>
        <div
          style={{
            fontSize: "var(--fs-label)",
            letterSpacing: "0.6px",
            textTransform: "uppercase",
            color: "var(--text-faint)",
            marginBottom: 10,
          }}
        >
          Connections
        </div>
        <div style={{ fontSize: "var(--fs-lead)", color: "var(--text-mid)", marginBottom: 6 }}>
          No connections yet.
        </div>
        <div style={{ fontSize: "var(--fs-body)", color: "var(--text-dim)" }}>
          Upload files via{" "}
          <button type="button" onClick={() => nav("/files")} style={link}>
            Files
          </button>
          , or query external data with DuckDB in the{" "}
          <button type="button" onClick={() => nav("/sql")} style={link}>
            SQL editor
          </button>
          .
        </div>
      </Card>

      <button
        type="button"
        onClick={() => nav("/autoetl")}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 14,
          padding: 22,
          color: "var(--text)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ color: "var(--accent)", fontSize: "var(--fs-lg)" }}>✦</span>
          <span style={{ fontSize: "var(--fs-md)", fontWeight: 600 }}>Auto ETL</span>
          <span style={{ marginLeft: "auto", color: "var(--text-faint)" }}>→</span>
        </div>
        <div style={{ fontSize: "var(--fs-body)", color: "var(--text-dim)", marginTop: 6 }}>
          Profile a table and build a star schema.
        </div>
      </button>
    </Page>
  );
}

const link: React.CSSProperties = {
  border: "none",
  background: "transparent",
  padding: 0,
  font: "inherit",
  fontSize: "var(--fs-body)",
  color: "var(--accent-ink)",
};
