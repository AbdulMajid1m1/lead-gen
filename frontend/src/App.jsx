import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { LayoutDashboard, Search, Users, Radar, Settings, Moon, Sun, Signal, Sparkles } from "lucide-react";
import { cn } from "./lib/format.js";
import SearchPage from "./pages/SearchPage.jsx";
import ResearchPage from "./pages/ResearchPage.jsx";
import ResearchHistoryPage from "./pages/ResearchHistoryPage.jsx";
import LeadsPage from "./pages/LeadsPage.jsx";
import LeadDetailPage from "./pages/LeadDetailPage.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import DiscoveryPage from "./pages/DiscoveryPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/research", label: "Deep research", icon: Sparkles },
  { to: "/search", label: "Quick search", icon: Search },
  { to: "/leads", label: "All leads", icon: Users },
  { to: "/discovery", label: "Discovery runs", icon: Radar },
  { to: "/settings", label: "Settings", icon: Settings },
];

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

  // A route change should always start at the top of the new page.
  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);

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
          {NAV.map(({ to, label, icon: Icon, end }) => (
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
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-[var(--border)] p-3">
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
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn("flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px]",
                isActive ? "text-[var(--accent)]" : "text-[var(--text-muted)]")}
          >
            <Icon size={17} />{label.split(" ")[0]}
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
