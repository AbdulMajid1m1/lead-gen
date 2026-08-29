import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Toaster } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { Logo } from "./components/Logo.jsx";
import { Moon, Sun, LogOut, Lock, Eye } from "lucide-react";
import { api } from "./lib/api.js";
import { cn } from "./lib/format.js";
import OutreachPage from "./pages/OutreachPage.jsx";
import SearchPage from "./pages/SearchPage.jsx";
import ResearchPage from "./pages/ResearchPage.jsx";
import ResearchHistoryPage from "./pages/ResearchHistoryPage.jsx";
import PromoterPage from "./pages/PromoterPage.jsx";
import LeadsPage from "./pages/LeadsPage.jsx";
import LeadDetailPage from "./pages/LeadDetailPage.jsx";
import DashboardPage from "./pages/DashboardPage.jsx";
import DiscoveryPage from "./pages/DiscoveryPage.jsx";
import InboxPage from "./pages/InboxPage.jsx";
import ClientsPage from "./pages/ClientsPage.jsx";
import ClientDetailPage from "./pages/ClientDetailPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import UsersPage from "./pages/UsersPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import { useAuth } from "./lib/auth.jsx";
import { landingPathFor, navFor } from "./lib/permissions.js";
import { Button, EmptyState, Spinner } from "./components/ui.jsx";

/**
 * How many outreach threads are actually waiting on the user: replies nobody
 * has judged, plus follow-ups that have come due.
 *
 * Shares its query key with the Inbox page, so opening the page costs nothing
 * and acting on a thread updates the badge without a second request. Skipped
 * entirely for an account without the Inbox, which would otherwise poll an
 * endpoint it is forbidden from reading every sixty seconds.
 */
const useAttentionCount = (enabled) => {
  const { data } = useQuery({
    queryKey: ["outreach-inbox", "", ""],
    queryFn: () => api.outreachInbox({ bucket: "", channel: "" }),
    enabled,
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

/**
 * What someone sees when they reach a screen they were not given.
 *
 * Shown rather than silently redirected: a URL from a colleague's message that
 * bounces you somewhere else with no explanation reads as a broken app, and the
 * next thing that happens is a support question instead of a permission request.
 */
const NoAccess = ({ landing }) => {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-6xl px-5 py-16 md:px-8">
      <EmptyState
        icon={Lock}
        title="You do not have access to this section"
        description="Your account has not been given this part of the console. A super admin can grant it from Team & permissions."
        action={landing
          ? <Button variant="secondary" onClick={() => navigate(landing, { replace: true })}>Take me somewhere I can work</Button>
          : null}
      />
    </div>
  );
};

/** An account with no sections at all — provisioned but not yet granted anything. */
const NothingGranted = () => (
  <div className="mx-auto max-w-6xl px-5 py-16 md:px-8">
    <EmptyState
      icon={Lock}
      title="Nothing has been shared with you yet"
      description="Your account is active but no sections have been granted. Ask a super admin to give you access from Team & permissions."
    />
  </div>
);

export default function App() {
  const [theme, setTheme] = useTheme();
  const location = useLocation();
  const { user, checking, signOut, can, canManageTeam, readOnly } = useAuth();
  const attention = useAttentionCount(Boolean(user) && can("inbox"));

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

  const nav = navFor(user);
  const landing = landingPathFor(user);

  /**
   * Route-level enforcement, mirroring the sidebar filter.
   *
   * Hiding a nav item is presentation; this is what makes typing the URL fail
   * too. Both are convenience — the API refuses the same request a third time —
   * but a console that renders a screen it cannot fill is worse than one that
   * says plainly that the screen is not yours.
   */
  const guard = (permission, element) =>
    can(permission) ? element : <NoAccess landing={landing} />;

  return (
    <div className="flex min-h-full">
      <aside className="fixed inset-y-0 left-0 hidden w-56 flex-col border-r border-[var(--border)] bg-[var(--surface-raised)] md:flex">
        <div className="px-5 py-5">
          <Logo size={28} />
        </div>

        <nav className="flex-1 space-y-0.5 px-3">
          {nav.map(({ to, label, icon: Icon, end, badge }) => (
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
          {/* A read-only seat is told so once, here, rather than discovering it
              one disabled button at a time. */}
          {readOnly && (
            <div className="mb-1 flex items-center gap-1.5 rounded-lg bg-[var(--surface-sunken)] px-2.5 py-1.5 text-[11px] text-[var(--text-muted)]">
              <Eye size={12} className="shrink-0" />Read-only access
            </div>
          )}
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
        {nav.map(({ to, label, icon: Icon, end, badge }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn("relative flex min-w-0 flex-1 flex-col items-center gap-1 px-0.5 py-2.5 text-[10px]",
                isActive ? "text-[var(--accent)]" : "text-[var(--text-muted)]")}
          >
            <Icon size={17} />
            <span className="w-full truncate text-center">{label.split(" ")[0]}</span>
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
          {/* The index is the dashboard for anyone who has it, and the first
              screen they *do* have for everyone else — so a promoter who was
              never given the dashboard lands on their own work, not a wall. */}
          <Route
            path="/"
            element={
              can("dashboard") ? <DashboardPage />
                : landing ? <Navigate to={landing} replace />
                : <NothingGranted />
            }
          />
          <Route path="/search" element={guard("search", <SearchPage />)} />
          <Route path="/research" element={guard("research", <ResearchPage />)} />
          <Route path="/research/history" element={guard("research", <ResearchHistoryPage />)} />
          <Route path="/promoter" element={guard("promoter", <PromoterPage />)} />
          <Route path="/leads" element={guard("leads", <LeadsPage />)} />
          <Route path="/leads/:id" element={guard("leads", <LeadDetailPage />)} />
          <Route path="/outreach" element={guard("outreach", <OutreachPage />)} />
          <Route path="/inbox" element={guard("inbox", <InboxPage />)} />
          <Route path="/clients" element={guard("clients", <ClientsPage />)} />
          <Route path="/clients/:id" element={guard("clients", <ClientDetailPage />)} />
          <Route path="/discovery" element={guard("discovery", <DiscoveryPage />)} />
          <Route path="/settings" element={guard("settings", <SettingsPage />)} />
          <Route path="/users" element={canManageTeam ? <UsersPage /> : <NoAccess landing={landing} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
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
