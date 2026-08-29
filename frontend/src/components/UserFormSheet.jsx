import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Check, Wand2, ShieldCheck, KeyRound, Eye, EyeOff, LayoutGrid } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { Button, FormField, Input, Select, Spinner } from "./ui.jsx";
import { useAuth } from "../lib/auth.jsx";
import { cn } from "../lib/format.js";

/**
 * The one place a team member is created or edited.
 *
 * Permissions are presented as the sidebar is, because that is the promise
 * being made: tick "Clients" and this person sees Clients. Presets are the
 * fast path — a new seat starts from "sales promoter" rather than from ten
 * empty boxes — and every preset is editable afterwards, so they set the ticks
 * without becoming a second, hidden permission model.
 *
 * The catalogue is fetched from the API rather than restated here, so the form
 * can never offer a permission the server does not enforce.
 */

const MIN_PASSWORD = 12;

/** Mirrors lib/auth/password.js. Answers faster than the server, never instead of it. */
export const passwordProblem = (value) => {
  if (!value || value.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (!/[a-z]/.test(value)) return "Add a lower-case letter.";
  if (!/[A-Z]/.test(value)) return "Add an upper-case letter.";
  if (!/[0-9]/.test(value)) return "Add a number.";
  return null;
};

/**
 * A strong password the admin does not have to invent.
 *
 * Drawn from crypto.getRandomValues with rejection sampling rather than
 * `% alphabet.length`, which would quietly bias the last few characters — a
 * small thing, but this is the one value in the form that has to be random.
 * Composition is forced so the generated value always clears the rules above.
 */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REQUIRED = ["abcdefghijkmnopqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789"];

/** Uniform in [0, max). Rejection sampling — a raw `% max` biases low values. */
const randomInt = (max) => {
  const limit = Math.floor(256 / max) * max;
  const buf = new Uint8Array(1);
  let byte;
  do {
    crypto.getRandomValues(buf);
    [byte] = buf;
  } while (byte >= limit);
  return byte % max;
};

const pick = (chars) => chars[randomInt(chars.length)];

export const generatePassword = (length = 18) => {
  const out = REQUIRED.map(pick);
  while (out.length < length) out.push(pick(ALPHABET));
  // Fisher–Yates, so the forced characters do not always sit at the front.
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
};

/** A password box with a reveal toggle and a generator. */
export const PasswordField = ({ value, onChange, label, help, error, autoFocus, id }) => {
  const [shown, setShown] = useState(false);
  return (
    <FormField label={label} required error={error} htmlFor={id}
      help={help || `At least ${MIN_PASSWORD} characters, with upper-case, lower-case and a number.`}>
      {(a) => (
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Input
              {...a}
              type={shown ? "text" : "password"}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="Set a strong password"
              autoComplete="new-password"
              maxLength={200}
              autoFocus={autoFocus}
              className="pr-9"
            />
            <button
              type="button"
              onClick={() => setShown((s) => !s)}
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-[var(--text-subtle)] hover:text-[var(--text)]"
              aria-label={shown ? "Hide password" : "Show password"}
            >
              {shown ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => { onChange(generatePassword()); setShown(true); }}
            title="Generate a strong password"
          >
            <Wand2 size={13} />Generate
          </Button>
        </div>
      )}
    </FormField>
  );
};

const emptyForm = () => ({ name: "", email: "", password: "", role: "MEMBER", permissions: [] });

const formFrom = (member) => ({
  name: member.name || "",
  email: member.email || "",
  password: "",
  role: member.role,
  // The stored grant, not the effective one: editing a super admin must not
  // show ten ticks that would imply un-ticking one does something.
  permissions: member.grantedPermissions || [],
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const validate = (form, { isEdit }) => {
  const errors = {};
  if (form.name.trim().length < 2) errors.name = "Enter this person's name — their sends are recorded under it.";
  if (!isEdit) {
    if (!EMAIL_RE.test(form.email.trim())) errors.email = "Enter a valid email address — this is how they sign in.";
    const problem = passwordProblem(form.password);
    if (problem) errors.password = problem;
  }
  if (form.role !== "ADMIN" && form.permissions.length === 0) {
    errors.permissions = "Tick at least one section, or they will sign in to an empty console.";
  }
  return errors;
};

export default function UserFormSheet({ open, onClose, member, catalog, onSaved }) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isEdit = Boolean(member);
  // The API refuses a super admin changing their own role or sections — the
  // rule that stops the console being left with nobody able to administer it.
  // Locking the controls here means it never gets as far as a rejected save.
  const isSelf = isEdit && member.id === user?.id;
  const [form, setForm] = useState(emptyForm);
  const [touched, setTouched] = useState(false);
  // Which record the open form was seeded from. Guards against re-seeding
  // mid-edit: React Query refetches on window focus, and reacting to a new
  // `member` object identity would discard whatever was being typed.
  const [seededFor, setSeededFor] = useState(null);

  useEffect(() => {
    if (!open) {
      if (seededFor !== null) setSeededFor(null);
      return;
    }
    const target = member?.id || "new";
    if (seededFor === target) return;
    setForm(member ? formFrom(member) : emptyForm());
    setTouched(false);
    setSeededFor(target);
  }, [open, member, seededFor]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [open, onClose]);

  const errors = useMemo(() => validate(form, { isEdit }), [form, isEdit]);
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  const groups = useMemo(() => {
    const byGroup = new Map();
    for (const permission of catalog?.permissions || []) {
      if (!byGroup.has(permission.group)) byGroup.set(permission.group, []);
      byGroup.get(permission.group).push(permission);
    }
    return [...byGroup.entries()];
  }, [catalog]);

  const roleMeta = (catalog?.roles || []).find((r) => r.key === form.role);
  const grantsEverything = Boolean(roleMeta?.implicitAll);

  const toggle = (key) =>
    setForm((f) => ({
      ...f,
      permissions: f.permissions.includes(key)
        ? f.permissions.filter((k) => k !== key)
        : [...f.permissions, key],
    }));

  const applyPreset = (preset) => {
    setForm((f) => ({ ...f, role: preset.role, permissions: [...preset.permissions] }));
    toast.success(`${preset.label} applied — adjust anything below before saving.`);
  };

  const save = useMutation({
    mutationFn: () => {
      const body = isEdit
        ? { name: form.name.trim(), role: form.role, permissions: form.permissions }
        : {
            name: form.name.trim(),
            email: form.email.trim(),
            password: form.password,
            role: form.role,
            permissions: form.permissions,
          };
      return isEdit ? api.updateUser(member.id, body) : api.createUser(body);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["team"] });
      onSaved?.(data?.user, form.password);
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(errors).length > 0) {
      toast.error("Some fields need attention before this can be saved.");
      return;
    }
    save.mutate();
  };

  if (!open) return null;
  const show = (key) => (touched ? errors[key] : undefined);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[3px]" onClick={onClose} aria-hidden />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? `Edit ${member.name || member.email}` : "Add a team member"}
        className="relative flex h-full w-full max-w-xl flex-col border-l border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--shadow-lg)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">{isEdit ? `Edit ${member.name || member.email}` : "Add a team member"}</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              {isSelf
                ? "This is your own seat. You can change your name; your role and sections have to be changed by another super admin."
                : isEdit
                ? "Changes to access take effect immediately, on every device they are signed in on."
                : "They sign in with the email and password you set here. Nothing is emailed to them — pass the password on yourself."}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--surface-sunken)]" aria-label="Close">
            <X size={16} />
          </button>
        </header>

        {/* The role list and the tick boxes are the catalogue. Rendering the
            form without it would offer an empty Role select and no sections,
            which reads as a broken screen rather than a loading one. */}
        {!catalog ? (
          <div className="flex flex-1 items-center justify-center"><Spinner size={20} /></div>
        ) : (
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
            {/* ── Who they are ── */}
            <section className="space-y-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">The person</h3>

              <FormField
                label="Full name" required error={show("name")}
                help="Shown on every email and message they send, so a lead's history says who reached out."
              >
                {(a) => (
                  <Input {...a} value={form.name} onChange={(e) => set("name")(e.target.value)}
                    onBlur={() => setTouched(true)} placeholder="Sara Al-Otaibi" maxLength={120} autoFocus />
                )}
              </FormField>

              {isEdit ? (
                <FormField label="Email" help="Sign-in addresses cannot be changed. Remove the seat and add a new one instead.">
                  {(a) => <Input {...a} value={form.email} readOnly disabled />}
                </FormField>
              ) : (
                <>
                  <FormField label="Email" required error={show("email")} help="Their sign-in address. It has to be unique.">
                    {(a) => (
                      <Input {...a} type="email" value={form.email} onChange={(e) => set("email")(e.target.value)}
                        onBlur={() => setTouched(true)} placeholder="sara@yourcompany.com" maxLength={255} autoComplete="off" />
                    )}
                  </FormField>

                  <PasswordField
                    label="Temporary password"
                    value={form.password}
                    onChange={set("password")}
                    error={show("password")}
                  />
                </>
              )}
            </section>

            {/* ── What they can do ── */}
            <section className="space-y-3 border-t border-[var(--border)] pt-5">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Access level</h3>

              <FormField
                label="Role"
                help={isSelf
                  ? "You cannot change your own role or sections. Ask another super admin to do it."
                  : roleMeta?.description}
              >
                {(a) => (
                  <Select {...a} value={form.role} disabled={isSelf} onChange={(e) => set("role")(e.target.value)}>
                    {(catalog?.roles || []).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                  </Select>
                )}
              </FormField>

              {!isSelf && !grantsEverything && (catalog?.presets || []).length > 0 && (
                <div>
                  <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
                    Start from a common seat
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {catalog.presets.map((preset) => (
                      <button
                        key={preset.key}
                        type="button"
                        onClick={() => applyPreset(preset)}
                        title={preset.description}
                        className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-[12px] text-[var(--text-muted)] shadow-[var(--shadow-xs)] transition-colors hover:border-[var(--accent)] hover:text-[var(--text)]"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[11px] text-[var(--text-subtle)]">
                    A starting point only — tick and un-tick freely afterwards.
                  </p>
                </div>
              )}
            </section>

            {/* ── The sidebar they will see ── */}
            <section className="space-y-3 border-t border-[var(--border)] pt-5">
              <div className="flex items-start gap-2">
                <LayoutGrid size={13} className="mt-0.5 shrink-0 text-[var(--text-subtle)]" />
                <div>
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                    Sections in their sidebar
                  </h3>
                  <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)]">
                    Exactly what is ticked here is what appears in their sidebar — and the only thing the API will answer for them.
                  </p>
                </div>
              </div>

              {grantsEverything ? (
                <div className="flex items-start gap-2.5 rounded-lg border border-[color-mix(in_oklch,var(--accent)_35%,transparent)] bg-[var(--accent-soft)] px-3 py-2.5 text-[12px] leading-snug text-[var(--text)]">
                  <ShieldCheck size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" />
                  <span>
                    A super admin sees every section, including this one, and can add or remove other people.
                    Individual sections are not adjustable for this role.
                  </span>
                </div>
              ) : (
                <>
                  {show("permissions") && (
                    <p role="alert" className="text-[11px] text-[var(--color-critical)]">{errors.permissions}</p>
                  )}
                  <div className="space-y-4">
                    {groups.map(([group, items]) => (
                      <fieldset key={group}>
                        <legend className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
                          {group}
                        </legend>
                        <ul className="space-y-1.5">
                          {items.map((permission) => {
                            const checked = form.permissions.includes(permission.key);
                            return (
                              <li key={permission.key}>
                                <label
                                  className={cn(
                                    "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
                                    isSelf ? "cursor-not-allowed opacity-70" : "cursor-pointer",
                                    checked
                                      ? "border-[color-mix(in_oklch,var(--accent)_45%,transparent)] bg-[var(--accent-soft)]"
                                      : "border-[var(--border)] hover:bg-[var(--surface-sunken)]",
                                  )}
                                >
                                  <input
                                    type="checkbox"
                                    className="sr-only"
                                    checked={checked}
                                    disabled={isSelf}
                                    onChange={() => toggle(permission.key)}
                                  />
                                  <span
                                    aria-hidden
                                    className={cn(
                                      "mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                                      checked
                                        ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]"
                                        : "border-[var(--border-strong)]",
                                    )}
                                  >
                                    {checked && <Check size={11} strokeWidth={3} />}
                                  </span>
                                  <span className="min-w-0">
                                    <span className="block text-[13px] font-medium leading-tight">{permission.label}</span>
                                    <span className="mt-0.5 block text-[11px] leading-snug text-[var(--text-muted)]">
                                      {permission.description}
                                    </span>
                                  </span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      </fieldset>
                    ))}
                  </div>
                </>
              )}
            </section>
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-5 py-3.5">
            <p className="text-[11px] text-[var(--text-muted)]">
              {grantsEverything
                ? "Full access"
                : `${form.permissions.length} section${form.permissions.length === 1 ? "" : "s"} selected`}
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? <Spinner size={13} /> : <KeyRound size={13} />}
                {isEdit ? "Save changes" : "Create account"}
              </Button>
            </div>
          </footer>
        </form>
        )}
      </aside>
    </div>
  );
}
