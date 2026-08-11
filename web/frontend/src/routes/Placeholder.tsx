import { Page, Card } from "../components/Page";

// Temporary chrome for screens still being ported from the Jinja UI to React.
export function Placeholder({ title, eyebrow }: { title: string; eyebrow?: string }) {
  return (
    <Page title={title} eyebrow={eyebrow}>
      <Card style={{ padding: 22, color: "var(--text-dim)", fontSize: 13 }}>
        This screen is being rebuilt in the React workbench to match the prototype.
      </Card>
    </Page>
  );
}
