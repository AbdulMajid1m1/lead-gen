import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard, Search, Users, Radar, Settings, Moon, Sun, Signal, Sparkles, LogOut, Inbox } from "lucide-react";
import { api } from "./lib/api.js";
import { cn } from "./lib/format.js";
import SearchPage from "./pages/SearchPage.jsx";
import ResearchPage from "./pages/ResearchPage.jsx";
import ResearchHistoryPage from "./pages/ResearchHistoryPage.jsx";
import LeadsPage from "./pages/LeadsPage.jsx";
import LeadDetailPage from "./pages/LeadDetailPage.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import DiscoveryPage from "./pages/DiscoveryPage.jsx";
import InboxPage from "./pages/InboxPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import { useAuth } from "./lib/auth.jsx";
import { Spinner } from "./components/ui.jsx";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/research", label: "Deep research", icon: Sparkles },
  { to: "/search", label: "Quick search", icon: Search },
  { to: "/leads", label: "All leads", icon: Users },
  // `badge` marks the one item that carries a count. Sits directly under the
  // lead-finding screens because it is where a lead goes after you contact it.
  { to: "/inbox", label: "Inbox", icon: Inbox, badge: true },
  { to: "/discovery", label: "Discovery runs", icon: Radar },
  { to: "/settings", label: "Settings", icon: Settings },
];

/**
 * How many outreach threads are actually waiting on the user: replies nobody
 * has judged, plus follow-ups that have come due.
 *
 * Shares its query key with the Inbox page, so opening the page costs nothing
 * and acting on a thread updates the badge without a second request.
 */
const useAttentionCount = () => {
  const { data } = useQuery({
    queryKey: ["outreach-inbox", "", ""],
    queryFn: () => api.outreachInbox({ bucket: "", channel: "" }),
    refetchInterval: 60_000,
    // A failed badge must never take the app down with it.
    retry: false,
  });
  return (data?.counts?.replied || 0) + (data?.counts?.due || 0);
};

const useTheme = () => {
  const [theme, setTheme] = useState(() => localStorage.getItem("leadsignal-theme") || "dark");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("leadsignal-theme", theme);
  }, [theme]);
  return [theme, setTheme];
};

export default function App() {
  const [theme, setTheme] = useTheme();
  const location = useLocation();
  const { user, checking, signOut } = useAuth();
  const attention = useAttentionCount();

  // A route change should always start at the top of the new page.
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);

  // Held until the cold-load session probe answers. Rendering the login form
  // first and then yanking it away is worse than a beat of nothing.
  if (checking) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner size={22} />
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <LoginPage />
        <Toaster theme={theme} position="bottom-right" richColors closeButton />
      </>
    );
  }

  return (
    <div className="flex min-h-full">
      <aside className="fixed inset-y-0 left-0 hidden w-56 flex-col border-r border-[var(--border)] bg-[var(--surface-raised)] md:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex size-7 items-center justify-center rounded-lg [background-image:var(--accent-gradient)] shadow-[0_2px_10px_var(--accent-glow)]">
            <Signal size={15} className="text-[var(--accent-fg)]" />
          </div>
          <span className="text-sm font-semibold tracking-tight">LeadSignal</span>
        </div>

        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.map(({ to, label, icon: Icon, end, badge }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors",
                  isActive
                    ? "bg-[var(--accent-soft)] text-[var(--accent)] shadow-[var(--shadow-xs)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]",
                )}
            >
              <Icon size={15} />{label}
              {badge && attention > 0 && (
                <span
                  className="tnum ml-auto rounded-full bg-[var(--accent)] px-1.5 py-px text-[10px] font-semibold text-[var(--accent-fg)]"
                  aria-label={`${attention} threads need attention`}
                >
                  {attention > 99 ? "99+" : attention}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="space-y-0.5 border-t border-[var(--border)] p-3">
          <div className="truncate px-2.5 pb-1 text-[11px] text-[var(--text-muted)]" title={user.email}>
            {user.name || user.email}
          </div>
          <button
            onClick={() => { signOut(); }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]"
          >
            <LogOut size={15} />Sign out
          </button>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]"
          >
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </button>
        </div>
      </aside>

      {/* Mobile navigation */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-[var(--border)] bg-[color-mix(in_oklch,var(--surface-raised)_86%,transparent)] backdrop-blur-lg md:hidden">
        {NAV.map(({ to, label, icon: Icon, end, badge }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn("relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px]",
                isActive ? "text-[var(--accent)]" : "text-[var(--text-muted)]")}
          >
            <Icon size={17} />{label.split(" ")[0]}
            {badge && attention > 0 && (
              <span
                className="tnum absolute right-1/2 top-1.5 -mr-3 rounded-full bg-[var(--accent)] px-1 py-px text-[9px] font-semibold text-[var(--accent-fg)]"
                aria-label={`${attention} threads need attention`}
              >
                {attention > 9 ? "9+" : attention}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      <main className="min-w-0 flex-1 pb-20 md:pb-0 md:pl-56">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/research" element={<ResearchPage />} />
          <Route path="/research/history" element={<ResearchHistoryPage />} />
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/leads/:id" element={<LeadDetailPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/discovery" element={<DiscoveryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>

      <Toaster theme={theme} position="bottom-right" richColors closeButton />
    </div>
  );
}

export const PageHeader = ({ title, description, actions }) => (
  <header className="border-b border-[var(--border)] bg-[var(--surface-raised)]">
    <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-4 px-5 py-6 md:px-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-[var(--text-muted)]">{description}</p>}
      </div>
      {actions}
    </div>
  </header>
);

export const PageBody = ({ children, className }) => (
  <div className={cn("mx-auto max-w-6xl px-5 py-6 md:px-8", className)}>{children}</div>
);
