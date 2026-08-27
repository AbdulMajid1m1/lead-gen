import { cn } from "../lib/format.js";
import { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, Inbox, Loader2, Trash2 } from "lucide-react";

export const Surface = ({ className, children, ...props }) => (
  <div
    className={cn(
      "rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--shadow-sm)]",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export const Badge = ({ className, tone, children, ...props }) => (
  <span
    className={cn(
      "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-tight whitespace-nowrap",
      !tone && "bg-[var(--surface-sunken)] text-[var(--text-muted)]",
      className,
    )}
    style={tone ? { backgroundColor: `color-mix(in oklch, ${tone} 15%, transparent)`, color: tone } : undefined}
    {...props}
  >
    {children}
  </span>
);

export const Button = ({ variant = "primary", size = "md", className, ...props }) => (
  <button
    className={cn(
      "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-150",
      "disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none",
      size === "sm" && "px-2.5 py-1.5 text-xs",
      size === "md" && "px-3.5 py-2 text-sm",
      size === "lg" && "px-5 py-2.5 text-sm",
      variant === "primary" &&
        "[background-image:var(--accent-gradient)] text-[var(--accent-fg)] shadow-[var(--shadow-xs)] hover:shadow-[0_4px_14px_var(--accent-glow)] hover:brightness-[1.07] active:brightness-[0.96] disabled:hover:brightness-100",
      variant === "secondary" &&
        "border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text)] shadow-[var(--shadow-xs)] hover:bg-[var(--surface-sunken)]",
      variant === "ghost" && "text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]",
      variant === "danger" && "border border-[color-mix(in_oklch,var(--color-critical)_35%,transparent)] text-[var(--color-critical)] hover:bg-[color-mix(in_oklch,var(--color-critical)_10%,transparent)]",
      className,
    )}
    {...props}
  />
);

/*
 * Shared form-control styling. One definition so every input, select and
 * textarea in the app has the same surface, radius, border and focus ring.
 */
const controlCls =
  "w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-2 text-sm text-[var(--text)] shadow-[var(--shadow-xs)] transition-colors placeholder:text-[var(--text-subtle)] hover:border-[color-mix(in_oklch,var(--accent)_35%,var(--border-strong))] focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)] disabled:cursor-not-allowed disabled:opacity-50";

export const Input = ({ className, ...props }) => (
  <input className={cn(controlCls, className)} {...props} />
);

export const Textarea = ({ className, ...props }) => (
  <textarea className={cn(controlCls, "min-h-20 resize-y", className)} {...props} />
);

export const Select = ({ className, children, ...props }) => (
  <select className={cn(controlCls, "cursor-pointer appearance-auto", className)} {...props}>
    {children}
  </select>
);

/**
 * Multi-select dropdown.
 *
 * A native `<select multiple>` was the first attempt and was wrong for this:
 * it needs cmd-click to add a second value, gives no count of what is selected,
 * and cannot show a per-option lead count. This keeps the same control surface
 * as `Select` but lets several values be ticked, which is what "show me the
 * leads of all these countries" actually asks for.
 *
 * `options` is `[{ value, label, hint }]`; `value` is an array of selected values.
 */
export const MultiSelect = ({ value = [], onChange, options = [], placeholder = "Any", summaryNoun = "selected", disabled, className }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  // Close on an outside click or Escape — a filter panel left hanging over the
  // results is worse than one that needs a second click to reopen.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKeyDown = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = (v) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  const summary =
    value.length === 0 ? placeholder
    : value.length === 1 ? (options.find((o) => o.value === value[0])?.label || value[0])
    : `${value.length} ${summaryNoun}`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled || options.length === 0}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(controlCls, "flex cursor-pointer items-center justify-between gap-2 text-left", className)}
      >
        <span className={cn("truncate", value.length === 0 && "text-[var(--text-subtle)]")}>{summary}</span>
        <ChevronDown size={14} className={cn("shrink-0 text-[var(--text-subtle)] transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="absolute z-30 mt-1 max-h-72 w-full min-w-52 overflow-y-auto rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] p-1 shadow-[var(--shadow-md)]"
        >
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mb-1 w-full rounded-md px-2 py-1.5 text-left text-xs font-medium text-[var(--text-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]"
            >
              Clear selection
            </button>
          )}
          {options.map((o) => {
            const checked = value.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={checked}
                onClick={() => toggle(o.value)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--surface-sunken)]"
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                    checked
                      ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]"
                      : "border-[var(--border-strong)]",
                  )}
                >
                  {checked && <Check size={11} strokeWidth={3} />}
                </span>
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint !== undefined && o.hint !== null && (
                  <span className="tnum shrink-0 text-[11px] text-[var(--text-subtle)]">{o.hint}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

/**
 * Score ring. The arc length *is* the score, so the shape carries the meaning
 * even before the number is read.
 */
export const ScoreRing = ({ score, size = 46, stroke = 4, tone }) => {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(100, score)) / 100);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role="img" aria-label={`Lead score ${score} out of 100`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-sunken)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={tone} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset}
        />
      </svg>
      <span
        className="tnum absolute inset-0 flex items-center justify-center font-semibold"
        style={{ fontSize: size * 0.32, color: tone }}
      >
        {score}
      </span>
    </div>
  );
};

export const EmptyState = ({ icon: Icon = Inbox, title, description, action }) => (
  <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
      <Icon size={22} className="text-[var(--text-subtle)]" />
    </div>
    <div className="max-w-md space-y-1">
      <h3 className="text-sm font-semibold text-[var(--text)]">{title}</h3>
      {description && <p className="text-sm leading-relaxed text-[var(--text-muted)]">{description}</p>}
    </div>
    {action}
  </div>
);

export const ErrorState = ({ error, onRetry }) => (
  <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
    <div className="rounded-xl border border-[color-mix(in_oklch,var(--color-critical)_30%,transparent)] bg-[color-mix(in_oklch,var(--color-critical)_8%,transparent)] p-3">
      <AlertCircle size={22} className="text-[var(--color-critical)]" />
    </div>
    <div className="max-w-md space-y-1">
      <h3 className="text-sm font-semibold">Something went wrong</h3>
      <p className="text-sm leading-relaxed text-[var(--text-muted)]">{error?.message || "An unexpected error occurred."}</p>
    </div>
    {onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>}
  </div>
);

export const Spinner = ({ className, size = 16 }) => (
  <Loader2 size={size} className={cn("animate-spin", className)} />
);

export const Skeleton = ({ className }) => <div className={cn("skeleton", className)} />;

export const SkeletonCard = () => (
  <div className="flex gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-4 shadow-[var(--shadow-sm)]">
    <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
    <div className="flex-1 space-y-2.5">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  </div>
);

export const SectionHeading = ({ icon: Icon, title, description, actions }) => (
  <div className="mb-3 flex items-start justify-between gap-4">
    <div className="flex items-start gap-2.5">
      {Icon && <Icon size={16} className="mt-0.5 shrink-0 text-[var(--text-subtle)]" />}
      <div>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-[var(--text-muted)]">{description}</p>}
      </div>
    </div>
    {actions}
  </div>
);

/** Key/value row used throughout the lead detail view. */
export const Field = ({ label, children, className }) => (
  <div className={cn("flex flex-col gap-0.5", className)}>
    <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">{label}</dt>
    <dd className="text-sm text-[var(--text)]">{children ?? "—"}</dd>
  </div>
);

/**
 * A labelled form control.
 *
 * Every input in the app owes the user four things: what it is, what a valid
 * value looks like, why it matters, and what went wrong. Bundling them here
 * means no form can quietly ship without them, and the label/description/error
 * are wired to the control by id so a screen reader announces them too.
 *
 * `children` is a render prop receiving the ids and invalid state to spread
 * onto the control.
 */
export const FormField = ({ label, hint, help, error, required, htmlFor, children, className }) => {
  const autoId = useId();
  const id = htmlFor || autoId;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [help ? helpId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
        {label}
        {required && <span className="ml-0.5 text-[var(--accent)]" aria-hidden>*</span>}
        {hint && <span className="ml-1.5 normal-case tracking-normal text-[var(--text-subtle)]">{hint}</span>}
      </label>

      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, "aria-required": required || undefined })}

      {error
        ? <p id={errorId} role="alert" className="flex items-center gap-1 text-[11px] leading-snug text-[var(--color-critical)]">
            <AlertCircle size={11} className="shrink-0" />{error}
          </p>
        : help && <p id={helpId} className="text-[11px] leading-snug text-[var(--text-subtle)]">{help}</p>}
    </div>
  );
};

/**
 * Destructive actions, behind a deliberate second click.
 *
 * Preferred over `window.confirm` where the deletion cascades: a browser dialog
 * cannot say *what else* goes with it, and this can. Reverts on blur or Escape,
 * so an accidental first click costs nothing.
 */
export const ConfirmDelete = ({ onConfirm, label = "Delete", confirmLabel = "Delete for good", title, disabled, size = "sm", className }) => {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setArmed(false); };
    document.addEventListener("keydown", onKey);
    // Auto-disarm, so a forgotten confirmation is never left sitting under a
    // stray click minutes later.
    const timer = setTimeout(() => setArmed(false), 6000);
    return () => { document.removeEventListener("keydown", onKey); clearTimeout(timer); };
  }, [armed]);

  if (!armed) {
    return (
      <Button variant="ghost" size={size} className={className} title={title || label} disabled={disabled} onClick={() => setArmed(true)}>
        <Trash2 size={12} />
        <span className="sr-only">{label}</span>
      </Button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Button variant="danger" size={size} disabled={disabled} onClick={() => { setArmed(false); onConfirm(); }} autoFocus onBlur={() => setArmed(false)}>
        {confirmLabel}
      </Button>
      <Button variant="ghost" size={size} onClick={() => setArmed(false)}>Cancel</Button>
    </span>
  );
};
