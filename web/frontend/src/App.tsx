import { useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, setUnauthorizedHandler, type User } from "./api";
import { useNarrow } from "./theme";
import { MobileGate } from "./components/MobileGate";
import { Wordmark } from "./components/Wordmark";
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
  /** True when the session died under us rather than the user signing out. */
  const [expired, setExpired] = useState(false);

  // Read by the 401 handler, which must not re-register on every auth change.
  const authRef = useRef<Auth>(auth);
  authRef.current = auth;

  useEffect(() => {
    // One 401 from any /api call ends the session everywhere (REQ-49): the
    // shell drops to Login instead of leaving a screen half-rendered behind an
    // error nobody can act on.
    setUnauthorizedHandler(() => {
      if (typeof authRef.current === "object") setExpired(true);
      setAuth("anon");
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    api
      .get<User>("/me")
      .then((u) => setAuth(u))
      .catch(() => setAuth("anon"));
  }, []);

  if (narrow) return <MobileGate />;
  // Between mount and /me: the shell's own background and the wordmark, so the
  // first paint is Pebbles rather than a white flash.
  if (auth === "loading") return <Boot />;
  if (auth === "anon") {
    return (
      <Login
        expired={expired}
        onAuthed={(u) => {
          setExpired(false);
          setAuth(u);
        }}
      />
    );
  }

  const user = auth;
  const signOut = () => {
    setExpired(false);
    api.post("/logout").finally(() => setAuth("anon"));
  };

  return (
    <Routes>
      <Route element={<AppShell user={user} onSignOut={signOut} />}>
        <Route path="/" element={<Home user={user} />} />
        <Route path="/nkoyo" element={<Nkoyo user={user} />} />
        <Route path="/files" element={<Files user={user} />} />
        <Route path="/catalog" element={<Catalog user={user} />} />
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
        <Route path="/engines" element={<Engines user={user} />} />
        <Route path="/engineconfig" element={<EngineConfig user={user} />} />
        <Route path="/hosts" element={<Hosts />} />
        <Route path="/users" element={<Users user={user} />} />
        <Route path="/groups" element={<Groups user={user} />} />
        <Route path="/usage" element={<Usage />} />
        <Route path="/settings" element={<Settings user={user} onSignOut={signOut} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

/** First-paint placeholder while /me is in flight — no spinner (spec §7). */
function Boot() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "var(--surface-alt)",
        gap: 10,
      }}
    >
      <div style={{ display: "grid", justifyItems: "center", gap: 10 }}>
        <Wordmark size={34} tone="surface" />
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Starting…</span>
      </div>
    </div>
  );
}
