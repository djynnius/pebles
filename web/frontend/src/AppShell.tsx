import { Outlet } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import type { User } from "./api";

// The authed shell: sticky dark sidebar + light topbar + routed content column.
export function AppShell({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        width: "100%",
        background: "var(--surface-alt)",
      }}
    >
      <Sidebar admin={user.admin === true} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <Topbar user={user} onSignOut={onSignOut} />
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <main style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
