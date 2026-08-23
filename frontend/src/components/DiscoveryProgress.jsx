import { useEffect, useState } from "react";
import { Check, X, Loader2, Circle, Radar } from "lucide-react";
import { Surface, Button } from "./ui.jsx";
import { api, subscribeToRun } from "../lib/api.js";
import { cn } from "../lib/format.js";

const STEP_ICON = {
  RUNNING: <Loader2 size={13} className="animate-spin text-[var(--accent)]" />,
  SUCCEEDED: <Check size={13} className="text-[var(--color-positive)]" />,
  FAILED: <X size={13} className="text-[var(--color-critical)]" />,
  PENDING: <Circle size={13} className="text-[var(--text-subtle)]" />,
};

const countLabel = (counts) => {
  if (!counts) return null;
  const parts = [];
  if (counts.found !== undefined) parts.push(`${counts.found} found`);
  if (counts.created !== undefined) parts.push(`${counts.created} new`);
  if (counts.withoutWebsite) parts.push(`${counts.withoutWebsite} without a website`);
  if (counts.crawled !== undefined) parts.push(`${counts.crawled} crawled`);
  if (counts.blocked) parts.push(`${counts.blocked} blocked`);
  if (counts.jobsIngested !== undefined) parts.push(`${counts.jobsIngested} jobs`);
  if (counts.boardsFound !== undefined) parts.push(`${counts.boardsFound} job boards`);
  if (counts.evaluated !== undefined) parts.push(`${counts.evaluated} analysed`);
  if (counts.leadsCreated !== undefined) parts.push(`${counts.leadsCreated} leads`);
  return parts.join(" · ") || null;
};

/**
 * Live view of a discovery run.
 *
 * Shows the plan up front — what the system is about to do and where it will
 * look — so a wait of a couple of minutes reads as work rather than a hang.
 */
export const DiscoveryProgress = ({ runId, onFinished }) => {
  const [run, setRun] = useState(null);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!runId) return undefined;
    let cancelled = false;

    api.getRun(runId).then((r) => !cancelled && setRun(r)).catch(() => {});

    const unsubscribe = subscribeToRun(
      runId,
      (event) => {
        if (cancelled) return;
        if (event.type === "snapshot") {
          setRun(event.run);
          setStats(event.run.stats);
        }
        if (event.stats) setStats(event.stats);
        if (event.type === "step.started" || event.type === "step.finished") {
          setRun((prev) => prev && {
            ...prev,
            steps: prev.steps.map((s) =>
              s.ordinal === event.ordinal
                ? { ...s, status: event.type === "step.started" ? "RUNNING" : event.status, counts: event.counts ?? s.counts, errorText: event.error ?? s.errorText }
                : s),
          });
        }
        if (event.type === "run.finished") {
          setRun((prev) => prev && { ...prev, status: event.status });
          onFinished?.(event.status);
        }
      },
      (err) => !cancelled && setError(err),
    );

    return () => { cancelled = true; unsubscribe(); };
  }, [runId, onFinished]);

  if (!run) {
    return (
      <Surface className="p-4">
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 size={14} className="animate-spin" />Starting discovery…
        </div>
      </Surface>
    );
  }

  const isRunning = ["PENDING", "RUNNING"].includes(run.status);
  const s = stats || run.stats || {};

  return (
    <Surface className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Radar size={15} className={cn("text-[var(--accent)]", isRunning && "animate-pulse")} />
          <div>
            <p className="text-sm font-semibold">
              {isRunning ? "Discovering new leads…" : `Discovery ${run.status.toLowerCase()}`}
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              Searching public sources. Results appear below as they are found.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs">
          <Stat label="Companies" value={s.companiesFound ?? 0} />
          <Stat label="Crawled" value={s.crawled ?? 0} />
          <Stat label="Jobs" value={s.jobsFound ?? 0} />
          <Stat label="Leads" value={s.leadsCreated ?? 0} highlight />
          {isRunning && (
            <Button variant="ghost" size="sm" onClick={() => api.cancelRun(runId).catch(() => {})}>Stop</Button>
          )}
        </div>
      </div>

      <ol className="divide-y divide-[var(--border)]">
        {run.steps.map((step) => (
          <li key={step.ordinal} className="flex items-start gap-3 px-4 py-2.5">
            <span className="mt-0.5">{STEP_ICON[step.status] || STEP_ICON.PENDING}</span>
            <div className="min-w-0 flex-1">
              <p className={cn("text-[13px]", step.status === "PENDING" ? "text-[var(--text-subtle)]" : "text-[var(--text)]")}>
                {step.label}
              </p>
              {countLabel(step.counts) && (
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">{countLabel(step.counts)}</p>
              )}
              {step.errorText && (
                <p className="mt-0.5 text-xs text-[var(--color-critical)]">{step.errorText}</p>
              )}
            </div>
          </li>
        ))}
      </ol>

      {error && (
        <p className="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--text-muted)]">
          Live updates disconnected — the run continues in the background.
        </p>
      )}
    </Surface>
  );
};

const Stat = ({ label, value, highlight }) => (
  <div className="text-right">
    <p className={cn("tnum text-sm font-semibold", highlight && "text-[var(--accent)]")}>{value}</p>
    <p className="text-[10px] uppercase tracking-wide text-[var(--text-subtle)]">{label}</p>
  </div>
);
