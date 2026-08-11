import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, type User } from "./api";
import { useNarrow } from "./theme";
import { MobileGate } from "./components/MobileGate";
import { AppShell } from "./AppShell";
import { Login } from "./routes/Login";
import { Home } from "./routes/Home";
import { Engines } from "./routes/Engines";
import { Usage } from "./routes/Usage";
import { Placeholder } from "./routes/Placeholder";

type Auth = "loading" | "anon" | User;

export function App() {
  const narrow = useNarrow();
  const [auth, setAuth] = useState<Auth>("loading");

  useEffect(() => {
    api
      .get<User>("/me")
      .then((u) => setAuth(u))
      .catch(() => setAuth("anon"));
  }, []);

  if (narrow) return <MobileGate />;
  if (auth === "loading") return null;
  if (auth === "anon") return <Login onAuthed={setAuth} />;

  const user = auth;
  const signOut = () => {
    api.post("/logout").finally(() => setAuth("anon"));
  };

  return (
    <Routes>
      <Route element={<AppShell user={user} onSignOut={signOut} />}>
        <Route path="/" element={<Home user={user} />} />
        <Route path="/nkoyo" element={<Placeholder title="Nkoyo" />} />
        <Route path="/files" element={<Placeholder title="Files" eyebrow="Workspace" />} />
        <Route path="/catalog" element={<Placeholder title="Catalog" eyebrow="Workspace" />} />
        <Route path="/notebooks" element={<Placeholder title="Notebooks" eyebrow="Analysis" />} />
        <Route path="/sql" element={<Placeholder title="SQL editor" eyebrow="Analysis" />} />
        <Route path="/dashboards" element={<Placeholder title="Dashboards" eyebrow="Analysis" />} />
        <Route path="/jobs" element={<Placeholder title="Jobs" eyebrow="Data engineering" />} />
        <Route path="/ingest" element={<Placeholder title="Ingestion" eyebrow="Data engineering" />} />
        <Route path="/autoetl" element={<Placeholder title="Auto ETL" eyebrow="Data engineering" />} />
        <Route path="/engines" element={<Engines />} />
        <Route path="/hosts" element={<Placeholder title="Hosts" eyebrow="Infrastructure" />} />
        <Route path="/users" element={<Placeholder title="Users &amp; access" eyebrow="Admin" />} />
        <Route path="/groups" element={<Placeholder title="Groups" eyebrow="Admin" />} />
        <Route path="/usage" element={<Usage />} />
        <Route path="/settings" element={<Placeholder title="Account &amp; Settings" />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
