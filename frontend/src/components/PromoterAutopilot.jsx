import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, Play, Pause, RefreshCw, AlertTriangle, Mail, Inbox } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { Badge, Button, Select, Skeleton, Spinner, Surface, SectionHeading } from "./ui.jsx";

/**
 * A product's standing outreach: which mailbox pitches it, how much a day, and
 * when. Everything the switch needs answering sits above it — the mailbox and
 * where it is on its warm-up ramp, how many leads are waiting, and what has
 * happened to the ones already written to. The daily figure shown is the one
 * the server will actually use, which the ramp can hold below the setting.
 */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Local time zones a Gulf or UK sender is likely to pick. Offsets are minutes east of UTC. */
const TZ_OPTIONS = [
  { value: 0, label: "London (UTC+0/+1)" },
  { value: 60, label: "Central Europe (UTC+1)" },
  { value: 180, label: "Riyadh (UTC+3)" },
  { value: 240, label: "Dubai (UTC+4)" },
  { value: 300, label: "Karachi (UTC+5)" },
  { value: -300, label: "New York (UTC-5)" },
];

const Labelled = ({ label, hint, help, children }) => (
  <label className="block">
    <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
      {label}
      {hint && <span className="ml-1 normal-case text-[var(--text-subtle)]">{hint}</span>}
    </span>
    <div className="mt-1">{children}</div>
    {help && <p className="mt-1 text-[11px] leading-snug text-[var(--text-subtle)]">{help}</p>}
  </label>
);

const Stat = ({ label, value, tone }) => (
  <div className="rounded-lg border border-[var(--border)] px-3 py-2">
    <div className="text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">{label}</div>
    <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone === "positive" ? "text-[var(--color-positive)]" : tone === "warning" ? "text-[var(--color-caution)]" : ""}`}>
      {value}
    </div>
  </div>
);

const campaignTone = (status) => (status === "RUNNING" ? "positive" : status === "PAUSED" ? "warning" : undefined);

export default function PromoterAutopilotPanel({ productId, product, onOpenTab }) {
  const qc = useQueryClient();
  const key = ["promoter", productId, "autopilot"];

  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.promoterAutopilot(productId),
    refetchInterval: 60_000,
  });
  const accounts = useQuery({
    queryKey: ["outreach", "accounts"],
    queryFn: () => api.listEmailAccounts().then((d) => d.accounts || []),
  });

  const save = useMutation({
    mutationFn: (patch) => api.updatePromoterAutopilot(productId, patch),
    onSuccess: (res, patch) => {
      qc.setQueryData(key, res);
      qc.invalidateQueries({ queryKey: ["outreach"] });
      if (patch.enabled !== undefined) {
        toast.success(res.settings?.enabled
          ? `Autopilot is on — ${product?.name || "this product"} sends inside the local window.`
          : "Autopilot is off. Nothing further will be sent for this product.");
      }
    },
    onError: (err) => toast.error(err.message || "Could not save."),
  });

  const runNow = useMutation({
    mutationFn: () => api.runPromoterAutopilot(productId),
    onSuccess: (res) => {
      qc.setQueryData(key, res);
      const r = res.result || {};
      toast.success(r.skipped ? `Nothing to do — ${r.skipped}.`
        : r.added ? `Queued ${r.added} lead${r.added === 1 ? "" : "s"}.` : "Already up to date.");
    },
    onError: (err) => toast.error(err.message || "Could not run."),
  });

  if (isLoading) return <Surface className="p-5"><Skeleton className="h-48 w-full" /></Surface>;
  if (error || !data?.settings) {
    return (
      <Surface className="p-5">
        <SectionHeading icon={Send} title="Outreach autopilot" />
        <p className="mt-3 flex items-start gap-1.5 text-xs text-[var(--text-subtle)]">
          <AlertTriangle size={14} className="mt-px shrink-0" />
          <span>Could not load the autopilot: {error?.message || "the server returned no settings."}</span>
        </p>
      </Surface>
    );
  }

  const s = data.settings;
  const sendDays = Array.isArray(s.sendDays) ? s.sendDays : [];
  const busy = save.isPending || runNow.isPending;
  const ramping = data.warmupCap != null && data.emailCeiling != null && data.warmupCap < data.emailCeiling;
  const approved = Boolean(product?.icpApproved);
  const accountList = accounts.data || [];
  const patch = (next) => save.mutate(next);
  const toggleDay = (d) => {
    const next = sendDays.includes(d) ? sendDays.filter((x) => x !== d) : [...sendDays, d].sort();
    if (!next.length) return toast.error("Pick at least one sending day.");
    patch({ sendDays: next });
  };
  const pad = (h) => String(h).padStart(2, "0");

  return (
    <div className="space-y-4">
      <Surface className="p-5">
        <SectionHeading
          icon={Send}
          title="Outreach autopilot"
          description="Keeps one campaign for this product topped up with newly found leads and sends them from its own mailbox, inside local working hours. Replies land in the Inbox like any other conversation."
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant="ghost" size="sm" disabled={busy || !s.enabled}
                onClick={() => runNow.mutate()}
                title="Queue newly eligible leads now instead of waiting for the next check"
              >
                {runNow.isPending ? <Spinner size={14} /> : <RefreshCw size={14} />} Top up now
              </Button>
              <Button
                variant={s.enabled ? "secondary" : "primary"} size="sm" disabled={busy || (!s.enabled && !approved)}
                onClick={() => patch({ enabled: !s.enabled })}
                title={!s.enabled && !approved ? "Approve the ICP first" : undefined}
              >
                {save.isPending ? <Spinner size={14} /> : s.enabled ? <Pause size={14} /> : <Play size={14} />}
                {s.enabled ? "Turn off" : "Turn on"}
              </Button>
            </div>
          }
        />

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Badge tone={s.enabled ? "positive" : undefined}>{s.enabled ? "On" : "Off"}</Badge>
          {data.account
            ? (
              <span className="inline-flex items-center gap-1 text-xs text-[var(--text-subtle)]">
                <Mail size={12} /> Sending as {data.account.email}{data.account.isDefault && !s.accountId ? " (the default mailbox)" : ""}
              </span>
            )
            : <Badge tone="warning">No mailbox connected</Badge>}
          {ramping && (
            <Badge tone="warning">
              Warming up — day {data.account?.warmupDay ?? "?"} of 21, {data.warmupCap}/day today, not {data.emailCeiling}
            </Badge>
          )}
          {data.campaign?.status && <Badge tone={campaignTone(data.campaign.status)}>Campaign {data.campaign.status.toLowerCase()}</Badge>}
        </div>

        {!approved && (
          <p className="mt-3 flex items-start gap-1 text-xs text-[var(--text-subtle)]">
            <AlertTriangle size={12} className="mt-px shrink-0" />
            <span>
              The ICP decides who gets written to, so approve it before switching this on.{" "}
              {onOpenTab && (
                <button type="button" className="underline" onClick={() => onOpenTab("profile")}>Open Profile &amp; ICP</button>
              )}
            </span>
          </p>
        )}

        {!s.enabled && approved && (
          <p className="mt-3 text-xs text-[var(--text-subtle)]">
            Nothing sends automatically while this is off. Turning it on queues the eligible leads at once and
            sends up to the daily figure below, starting at the mailbox's warm-up pace.
          </p>
        )}

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Labelled
            label="Sending mailbox"
            help="Use a mailbox that belongs to this product, so replies and reputation stay separate from the agency's."
          >
            <Select
              value={s.accountId ?? ""}
              disabled={busy || accounts.isLoading}
              onChange={(e) => patch({ accountId: e.target.value === "" ? null : e.target.value })}
            >
              <option value="">Default mailbox</option>
              {accountList.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName ? `${a.displayName} <${a.email}>` : a.email}{a.status !== "CONNECTED" ? ` · ${a.status.toLowerCase()}` : ""}
                </option>
              ))}
            </Select>
          </Labelled>

          <Labelled
            label="Daily limit"
            help={`The warm-up ramp is the ceiling on a young mailbox: 5 a day for two days, then 10, 20, 35, 50, and the full cap from day 21. Today that means ${data.budget} for this product.`}
          >
            <Select
              value={s.dailyLimit ?? ""}
              disabled={busy}
              onChange={(e) => patch({ dailyLimit: e.target.value === "" ? null : Number(e.target.value) })}
            >
              <option value="">Whatever the warm-up allows{data.emailCeiling ? ` (up to ${data.emailCeiling})` : ""}</option>
              {[5, 10, 15, 20, 30, 40].map((n) => <option key={n} value={n}>{n} a day</option>)}
            </Select>
          </Labelled>

          <Labelled label="Local sending window" help="The reader's morning, in their time zone. One message a minute at most, so a narrow window caps the day as well.">
            <div className="flex items-center gap-2">
              <Select className="w-full" value={s.windowStart} disabled={busy} onChange={(e) => patch({ windowStart: Number(e.target.value) })}>
                {Array.from({ length: 23 }, (_, h) => <option key={h} value={h}>{pad(h)}:00</option>)}
              </Select>
              <span className="text-xs text-[var(--text-subtle)]">to</span>
              <Select className="w-full" value={s.windowEnd} disabled={busy} onChange={(e) => patch({ windowEnd: Number(e.target.value) })}>
                {Array.from({ length: 23 }, (_, h) => h + 1).map((h) => <option key={h} value={h}>{pad(h)}:00</option>)}
              </Select>
            </div>
          </Labelled>

          <Labelled label="Time zone" help="Where most of this product's leads are.">
            <Select value={s.tzOffsetMinutes} disabled={busy} onChange={(e) => patch({ tzOffsetMinutes: Number(e.target.value) })}>
              {TZ_OPTIONS.some((t) => t.value === s.tzOffsetMinutes) ? null : <option value={s.tzOffsetMinutes}>UTC offset {s.tzOffsetMinutes} min</option>}
              {TZ_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </Labelled>
        </div>

        <div className="mt-4">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Sending days</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {DAY_LABELS.map((label, d) => (
              <button
                key={d} type="button" disabled={busy} onClick={() => toggleDay(d)}
                aria-pressed={sendDays.includes(d)}
                className={`rounded-md border px-2.5 py-1 text-xs transition ${
                  sendDays.includes(d)
                    ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--text-subtle)] hover:border-[var(--text-subtle)]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
            Monday to Friday by default. Gulf businesses work Sunday; pick it if most leads are there.
          </p>
        </div>
      </Surface>

      <Surface className="p-5">
        <SectionHeading icon={Inbox} title="Progress" description="Where this product's leads are, from queued to answered." />
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          <Stat label="Eligible" value={data.eligible} />
          <Stat label="Queued" value={data.progress.pending} />
          <Stat label="Sent today" value={data.progress.sentToday} />
          <Stat label="Sent total" value={data.progress.sent} />
          <Stat label="Awaiting reply" value={data.outcomes.awaiting} />
          <Stat label="Replied" value={data.outcomes.replied} tone={data.outcomes.replied ? "positive" : undefined} />
          <Stat label="Bounced" value={data.outcomes.bounced} tone={data.outcomes.bounced ? "warning" : undefined} />
        </div>
        {data.campaign?.pausedReason && (
          <p className="mt-3 flex items-start gap-1 text-[11px] leading-snug text-[var(--text-subtle)]">
            <AlertTriangle size={12} className="mt-px shrink-0" />
            <span>{data.campaign.pausedReason} Resume it from the Outreach page once the addresses are cleaned.</span>
          </p>
        )}
        <p className="mt-3 text-[11px] text-[var(--text-subtle)]">
          {data.progress.skipped > 0 && `${data.progress.skipped} skipped (no lawful or usable address). `}
          {data.progress.failed > 0 && `${data.progress.failed} failed at the mail server. `}
          {s.lastRunAt ? `Last checked ${new Date(s.lastRunAt).toLocaleString()}.` : "Not run yet."}
        </p>
      </Surface>
    </div>
  );
}
