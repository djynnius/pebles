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
import { Users } from "./routes/Users";
import { Groups } from "./routes/Groups";
import { Hosts } from "./routes/Hosts";
import { Catalog } from "./routes/Catalog";
import { NewCatalog } from "./routes/NewCatalog";
import { Files } from "./routes/Files";
import { Sql } from "./routes/Sql";
import { Notebooks } from "./routes/Notebooks";
import { Notebook } from "./routes/Notebook";
import { Dashboards } from "./routes/Dashboards";
import { Dashboard } from "./routes/Dashboard";
import { Jobs } from "./routes/Jobs";
import { JobBuilder } from "./routes/JobBuilder";
import { JobRun } from "./routes/JobRun";
import { Ingest } from "./routes/Ingest";
import { Nkoyo } from "./routes/Nkoyo";
import { Settings } from "./routes/Settings";
import { EngineConfig } from "./routes/EngineConfig";
import { AutoEtl } from "./routes/AutoEtl";

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
        <Route path="/nkoyo" element={<Nkoyo user={user} />} />
        <Route path="/files" element={<Files user={user} />} />
        <Route path="/catalog" element={<Catalog />} />
        <Route path="/newcatalog" element={<NewCatalog user={user} />} />
        <Route path="/notebooks" element={<Notebooks />} />
        <Route path="/notebooks/:name" element={<Notebook />} />
        <Route path="/sql" element={<Sql />} />
        <Route path="/dashboards" element={<Dashboards />} />
        <Route path="/dashboards/:name" element={<Dashboard />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/jobbuilder" element={<JobBuilder />} />
        <Route path="/jobs/:name/runs/:runId" element={<JobRun />} />
        <Route path="/ingest" element={<Ingest />} />
        <Route path="/autoetl" element={<AutoEtl />} />
        <Route path="/engines" element={<Engines />} />
        <Route path="/engineconfig" element={<EngineConfig />} />
        <Route path="/hosts" element={<Hosts />} />
        <Route path="/users" element={<Users />} />
        <Route path="/groups" element={<Groups />} />
        <Route path="/usage" element={<Usage />} />
        <Route path="/settings" element={<Settings user={user} onSignOut={signOut} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
