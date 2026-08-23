import { useState } from "react";
import { Signal, Lock, Mail, Eye, EyeOff } from "lucide-react";
import { Button, Input, Spinner } from "../components/ui.jsx";
import { useAuth } from "../lib/auth.jsx";

/**
 * Sign-in screen.
 *
 * The server's message is shown verbatim rather than being remapped here: it
 * already distinguishes "incorrect credentials" from "locked out, try again in
 * N minutes", and an operator who is locked out needs to read that second one.
 */
export default function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      // No navigation needed — App swaps the whole tree once user is set.
    } catch (err) {
      setError(err.message || "Could not sign in.");
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[var(--surface)] px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl [background-image:var(--accent-gradient)] shadow-[0_2px_16px_var(--accent-glow)]">
            <Signal size={22} className="text-[var(--accent-fg)]" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Sign in to LeadSignal</h1>
            <p className="mt-1 text-[13px] text-[var(--text-muted)]">
              This console is restricted to authorised accounts.
            </p>
          </div>
        </div>

        <form
          onSubmit={submit}
          className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-6 shadow-[var(--shadow-sm)]"
        >
          <div className="space-y-1.5">
            <label htmlFor="email" className="text-[13px] font-medium text-[var(--text-muted)]">
              Email
            </label>
            <div className="relative">
              <Mail
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
              />
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                autoFocus
                className="pl-9"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-[13px] font-medium text-[var(--text-muted)]">
              Password
            </label>
            <div className="relative">
              <Lock
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
              />
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                className="pl-9 pr-9"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text)]"
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-lg border border-[var(--danger-border,var(--border))] bg-[var(--danger-soft,var(--surface-sunken))] px-3 py-2 text-[13px] text-[var(--danger,var(--text))]"
            >
              {error}
            </p>
          )}

          <Button type="submit" className="w-full justify-center" disabled={busy}>
            {busy ? <><Spinner size={15} /> Signing in…</> : "Sign in"}
          </Button>
        </form>

        <p className="mt-5 text-center text-[12px] text-[var(--text-muted)]">
          Accounts are provisioned by an administrator.
        </p>
      </div>
    </div>
  );
}
