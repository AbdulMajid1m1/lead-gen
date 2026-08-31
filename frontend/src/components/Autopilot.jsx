import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radar, Play, Pause, RefreshCw, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { Badge, Button, Select, Skeleton, Spinner, Surface, SectionHeading } from "./ui.jsx";

/**
 * The standing outreach automation.
 *
 * The switch is the point of this panel, so everything else answers the two
 * questions someone asks before they flip it: what will go out, and to whom.
 * The per-lane table is the honest answer — it shows the real daily split the
 * server computed, not the setting that was asked for, because the warm-up ramp
 * and the shared mailbox cap can both hold the real number below it.
 */

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const RESTRICTED_COPY = {
  ROLE_ONLY: "Role mailboxes only in restricted markets (info@, contact@) — they identify no individual.",
  HOLD: "Restricted markets are skipped entirely. Only the opt-out markets are contacted.",
  SEND: "Restricted markets are treated as sendable. Highest volume, highest exposure.",
};

const Labelled = ({ label, hint, children }) => (
  <label className="block">
    <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
      {label}
      {hint && <span className="ml-1 normal-case text-[var(--text-subtle)]">{hint}</span>}
    </span>
    <div className="mt-1">{children}</div>
  </label>
);

/** Offset in minutes east of UTC → the "UTC+3" a person recognises. */
const tzLabel = (minutes) => {
  const sign = minutes < 0 ? "-" : "+";
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
};

const laneTone = (lane) => {
  if (!lane.status) return undefined;
  if (lane.status === "RUNNING") return "positive";
  if (lane.status === "PAUSED") return "warning";
  return undefined;
};

export default function AutopilotSection() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["outreach", "autopilot"],
    queryFn: () => api.get("/outreach/autopilot"),
    refetchInterval: 60_000,
  });

  const save = useMutation({
    mutationFn: (patch) => api.put("/outreach/autopilot", patch),
    onSuccess: (res) => {
      qc.setQueryData(["outreach", "autopilot"], res);
      qc.invalidateQueries({ queryKey: ["outreach"] });
      toast.success(res.message || "Saved.");
    },
    onError: (err) => toast.error(err.message || "Could not save."),
  });

  const runNow = useMutation({
    mutationFn: () => api.post("/outreach/autopilot/run"),
    onSuccess: (res) => {
      qc.setQueryData(["outreach", "autopilot"], res);
      const added = (res.result?.toppedUp || 0) + (res.result?.created || 0);
      toast.success(res.result?.skipped
        ? `Nothing to do — ${res.result.skipped}.`
        : added ? `Topped up ${added} lead${added === 1 ? "" : "s"}.` : "Already up to date.");
    },
    onError: (err) => toast.error(err.message || "Could not run."),
  });

  if (isLoading) return <Surface className="p-5"><Skeleton className="h-40 w-full" /></Surface>;
  if (error) return null;

  const s = data.settings;
  const channels = Array.isArray(s.channels) ? s.channels : [];
  const sendDays = Array.isArray(s.sendDays) ? s.sendDays : [];
  const busy = save.isPending || runNow.isPending;
  const totalPending = data.lanes.reduce((sum, l) => sum + (l.pending || 0), 0);
  const sentToday = data.lanes.reduce((sum, l) => sum + (l.sentToday || 0), 0);
  const ramping = data.warmupCap != null && data.emailCeiling != null && data.warmupCap < data.emailCeiling;

  const patch = (next) => save.mutate(next);
  const toggleDay = (d) => {
    const next = sendDays.includes(d) ? sendDays.filter((x) => x !== d) : [...sendDays, d].sort();
    if (!next.length) return toast.error("Pick at least one sending day.");
    patch({ sendDays: next });
  };

  return (
    <Surface className="p-5">
      <SectionHeading
        icon={Radar}
        title="Outreach autopilot"
        description="Keeps a campaign per region topped up with newly eligible leads and sends inside local working hours. Promoter leads are never included."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost" size="sm" disabled={busy || !s.enabled}
              onClick={() => runNow.mutate()}
              title="Pull in newly eligible leads now instead of waiting for the next check"
            >
              {runNow.isPending ? <Spinner size={14} /> : <RefreshCw size={14} />} Top up now
            </Button>
            <Button
              variant={s.enabled ? "secondary" : "primary"} size="sm" disabled={busy}
              onClick={() => patch({ enabled: !s.enabled })}
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
          ? <span className="text-xs text-[var(--text-subtle)]">Sending as {data.account.email}</span>
          : <Badge tone="warning">No mailbox connected</Badge>}
        {ramping && (
          <Badge tone="warning">
            Warming up — {data.warmupCap}/day today, not {data.emailCeiling}
          </Badge>
        )}
      </div>

      {!s.enabled && (
        <p className="mt-3 text-xs text-[var(--text-subtle)]">
          Nothing sends automatically while this is off. Turning it on resumes the lanes it paused —
          a lane the bounce guard stopped stays stopped until you look at it.
        </p>
      )}

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <Labelled label="Restricted markets" hint="(UAE, Saudi, Portugal, unknown)">
          <Select
            value={s.restrictedPolicy}
            disabled={busy}
            onChange={(e) => patch({ restrictedPolicy: e.target.value })}
          >
            <option value="ROLE_ONLY">Role mailboxes only</option>
            <option value="HOLD">Skip entirely</option>
            <option value="SEND">Send to all</option>
          </Select>
          <p className="mt-1 text-[11px] leading-snug text-[var(--text-subtle)]">
            {RESTRICTED_COPY[s.restrictedPolicy]}
          </p>
        </Labelled>

        <Labelled label="Channels">
          <Select
            value={channels.includes("WHATSAPP") ? (channels.includes("EMAIL") ? "BOTH" : "WHATSAPP") : "EMAIL"}
            disabled={busy}
            onChange={(e) => patch({
              channels: e.target.value === "BOTH" ? ["EMAIL", "WHATSAPP"] : [e.target.value],
            })}
          >
            <option value="EMAIL">Email only</option>
            <option value="WHATSAPP">WhatsApp only</option>
            <option value="BOTH">Email and WhatsApp</option>
          </Select>
          {channels.includes("WHATSAPP") && (
            <p className="mt-1 flex items-start gap-1 text-[11px] leading-snug text-[var(--text-subtle)]">
              <AlertTriangle size={12} className="mt-px shrink-0" />
              A banned WhatsApp number is permanent. Keep the daily figure low.
            </p>
          )}
        </Labelled>

        <Labelled label="Local sending window">
          <div className="flex items-center gap-2">
            <Select
              className="w-full" value={s.windowStart} disabled={busy}
              onChange={(e) => patch({ windowStart: Number(e.target.value) })}
            >
              {Array.from({ length: 23 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
            </Select>
            <span className="text-xs text-[var(--text-subtle)]">to</span>
            <Select
              className="w-full" value={s.windowEnd} disabled={busy}
              onChange={(e) => patch({ windowEnd: Number(e.target.value) })}
            >
              {Array.from({ length: 23 }, (_, h) => h + 1).map((h) => (
                <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
              ))}
            </Select>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-[var(--text-subtle)]">
            Each region's own local time. A narrow window with a high daily figure cannot
            fit — the queue sends at most one message a minute.
          </p>
        </Labelled>

        <Labelled label="Daily total" hint="(across all regions)">
          <Select
            value={s.dailyLimit ?? ""}
            disabled={busy}
            onChange={(e) => patch({ dailyLimit: e.target.value === "" ? null : Number(e.target.value) })}
          >
            <option value="">Whatever the warm-up allows{data.emailCeiling ? ` (${data.emailCeiling})` : ""}</option>
            {[5, 10, 20, 30, 40, 60, 80, 100].map((n) => <option key={n} value={n}>{n} a day</option>)}
          </Select>
          <p className="mt-1 text-[11px] leading-snug text-[var(--text-subtle)]">
            Split between regions in proportion to how many leads each has left.
          </p>
        </Labelled>
      </div>

      <div className="mt-4">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
          Sending days
        </span>
        <div className="mt-1 flex flex-wrap gap-1">
          {DAY_LABELS.map((label, d) => (
            <button
              key={d} type="button" disabled={busy} onClick={() => toggleDay(d)}
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
          Tuesday to Thursday by default — Monday and Friday reply worst on cold business email.
        </p>
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-xs">
          <thead className="text-[var(--text-subtle)]">
            <tr className="border-b border-[var(--border)]">
              <th className="py-1.5 font-medium">Region</th>
              <th className="py-1.5 font-medium">Local hours</th>
              <th className="py-1.5 font-medium text-right">Per day</th>
              <th className="py-1.5 font-medium text-right">Sent 24h</th>
              <th className="py-1.5 font-medium text-right">Queued</th>
              <th className="py-1.5 font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {data.lanes.map((lane) => (
              <tr key={lane.key} className="border-b border-[var(--border)] last:border-0">
                <td className="py-1.5">{lane.label}</td>
                <td className="py-1.5 text-[var(--text-subtle)]">
                  {lane.status
                    ? `${String(lane.windowStart).padStart(2, "0")}:00–${String(lane.windowEnd).padStart(2, "0")}:00 ${tzLabel(lane.tzOffsetMinutes)}`
                    : "—"}
                </td>
                <td className="py-1.5 text-right tabular-nums">{lane.dailyLimit || "—"}</td>
                <td className="py-1.5 text-right tabular-nums">{lane.sentToday || 0}</td>
                <td className="py-1.5 text-right tabular-nums">{lane.pending || 0}</td>
                <td className="py-1.5">
                  {lane.status
                    ? <Badge tone={laneTone(lane)}>{lane.status}</Badge>
                    : <span className="text-[var(--text-subtle)]">not started</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.lanes.some((l) => l.pausedReason) && (
        <div className="mt-3 space-y-1">
          {data.lanes.filter((l) => l.pausedReason).map((l) => (
            <p key={l.key} className="flex items-start gap-1 text-[11px] leading-snug text-[var(--text-subtle)]">
              <AlertTriangle size={12} className="mt-px shrink-0" />
              <span><strong>{l.label}:</strong> {l.pausedReason}</span>
            </p>
          ))}
        </div>
      )}

      <p className="mt-3 text-[11px] text-[var(--text-subtle)]">
        {totalPending} lead{totalPending === 1 ? "" : "s"} queued across all regions
        {sentToday > 0 && `, ${sentToday} contacted in the last 24 hours`}.
        {s.lastRunAt && ` Last checked ${new Date(s.lastRunAt).toLocaleTimeString()}.`}
      </p>
    </Surface>
  );
}
