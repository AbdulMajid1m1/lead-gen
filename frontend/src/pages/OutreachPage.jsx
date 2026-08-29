import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, Legend,
} from "recharts";
import {
  Send, Mail, MessageCircle, Reply, Pause, Play, XCircle, ChevronDown, ChevronRight, ArrowRight, Gauge, AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { PageBody, PageHeader } from "../App.jsx";
import { api } from "../lib/api.js";
import { Badge, Button, EmptyState, ErrorState, Skeleton, Surface, SectionHeading } from "../components/ui.jsx";
import { formatDateTime, titleize, cn } from "../lib/format.js";

const CAMPAIGN_TONE = {
  RUNNING: "var(--accent)",
  PAUSED: "var(--color-caution)",
  COMPLETED: "var(--color-positive)",
  CANCELLED: "var(--color-ink-400)",
};

/** Sum daily rows into ISO weeks for the weekly view. */
const toWeekly = (daily) => {
  const weeks = new Map();
  for (const d of daily) {
    const date = new Date(d.date);
    const monday = new Date(date);
    monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    const row = weeks.get(key) || { date: key, email: 0, whatsapp: 0, replies: 0 };
    row.email += d.email; row.whatsapp += d.whatsapp; row.replies += d.replies;
    weeks.set(key, row);
  }
  return [...weeks.values()];
};

/**
 * The outreach control room: what went out, on which channel, what came back,
 * and every bulk campaign with a live progress bar. The replies feed at the
 * bottom is the payoff — the whole pipeline exists to fill it.
 */
export default function OutreachPage() {
  const [params] = useSearchParams();
  const focusCampaign = params.get("campaign");
  const [days, setDays] = useState(30);
  const [granularity, setGranularity] = useState("daily");

  const { data: stats, isPending, isError, error, refetch } = useQuery({
    queryKey: ["outreach-stats", days],
    queryFn: () => api.outreachStats({ days }),
    refetchInterval: 30_000,
  });

  const { data: campaignData } = useQuery({
    queryKey: ["campaigns"],
    queryFn: api.listCampaigns,
    // Poll fast while anything is draining, settle down otherwise.
    refetchInterval: (q) => (q.state.data?.campaigns?.some((c) => c.status === "RUNNING") ? 6_000 : 30_000),
  });

  const campaigns = campaignData?.campaigns || [];
  const series = useMemo(
    () => (granularity === "weekly" ? toWeekly(stats?.daily || []) : stats?.daily || []),
    [stats, granularity],
  );

  if (isPending) {
    return (
      <div>
        <PageHeader title="Outreach" description="Loading…" />
        <PageBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </PageBody>
      </div>
    );
  }
  if (isError) return <PageBody><ErrorState error={error} onRetry={refetch} /></PageBody>;

  const t = stats.totals;

  return (
    <div>
      <PageHeader
        title="Outreach"
        description="Everything sent, everything answered — and every bulk campaign as it drains."
        actions={<Link to="/leads"><Button variant="secondary"><Send size={14} />Select leads to send</Button></Link>}
      />

      <PageBody className="space-y-5">
        {/* ── Headline numbers ─────────────────────────────────────────────── */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat icon={Send} label="Sent today" value={t.sentToday}
            sub={`${t.emailToday} email · ${t.whatsappToday} WhatsApp`} />
          <Stat icon={Mail} label="Sent this week" value={t.sentThisWeek}
            sub={`${t.sentInRange} in the last ${days} days`} />
          <Stat icon={Reply} label="Replies" value={t.repliesThisWeek}
            sub={`${t.repliesToday} today · ${t.repliesInRange} in range`} tone="var(--color-positive)" />
          <Stat icon={Gauge} label="Reply rate" value={`${t.replyRate}%`}
            sub={`over the last ${days} days`} tone={t.replyRate >= 5 ? "var(--color-positive)" : undefined} />
        </div>

        {/* ── Activity chart ───────────────────────────────────────────────── */}
        <Surface className="p-5">
          <SectionHeading
            title="Activity"
            description="Outbound messages by channel, replies overlaid."
            actions={
              <div className="flex items-center gap-1.5">
                {[["daily", "Daily"], ["weekly", "Weekly"]].map(([value, label]) => (
                  <button key={value} onClick={() => setGranularity(value)}
                    className={cn("rounded-lg border px-2.5 py-1 text-xs transition-colors",
                      granularity === value ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-muted)]")}>
                    {label}
                  </button>
                ))}
                <span className="mx-1 h-4 w-px bg-[var(--border)]" />
                {[14, 30, 90].map((d) => (
                  <button key={d} onClick={() => setDays(d)}
                    className={cn("rounded-lg border px-2.5 py-1 text-xs transition-colors",
                      days === d ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--border)] text-[var(--text-muted)]")}>
                    {d}d
                  </button>
                ))}
              </div>
            }
          />
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false}
                  tick={{ fill: "var(--text-subtle)", fontSize: 10 }}
                  tickFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  minTickGap={28} />
                <YAxis tickLine={false} axisLine={false} tick={{ fill: "var(--text-subtle)", fontSize: 10 }} allowDecimals={false} width={30} />
                <Tooltip
                  cursor={{ fill: "color-mix(in oklch, var(--accent) 6%, transparent)" }}
                  contentStyle={{ background: "var(--surface-raised)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12, color: "var(--text)" }}
                  labelFormatter={(d) => new Date(d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="email" name="Email" stackId="out" fill="var(--accent)" radius={[0, 0, 0, 0]} />
                <Bar dataKey="whatsapp" name="WhatsApp" stackId="out" fill="var(--color-positive)" radius={[3, 3, 0, 0]} />
                <Line dataKey="replies" name="Replies" stroke="var(--color-caution)" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Per-sender cap usage — the answer to "why did sending pause?". */}
          {stats.senders.length > 0 && (
            <div className="mt-4 grid gap-2 border-t border-[var(--border)] pt-3 sm:grid-cols-2 lg:grid-cols-3">
              {stats.senders.map((s) => (
                <div key={`${s.channel}:${s.id}`} className="rounded-lg border border-[var(--border)] px-3 py-2">
                  <div className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                      {s.channel === "EMAIL" ? <Mail size={11} /> : <MessageCircle size={11} />}
                      <span className="truncate">{s.label}</span>
                    </span>
                    <span className="tnum shrink-0 text-[var(--text-muted)]">{s.sentToday}/{s.cap} today</span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                    <div className="h-full rounded-full" style={{
                      width: `${Math.min(100, (s.sentToday / s.cap) * 100)}%`,
                      background: s.sentToday >= s.cap ? "var(--color-caution)" : "var(--accent)",
                    }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Surface>

        {/* ── Campaigns ────────────────────────────────────────────────────── */}
        <div>
          <SectionHeading title="Campaigns" description="Each bulk send, draining one message at a time." />
          {campaigns.length === 0 ? (
            <Surface className="border-dashed">
              <EmptyState icon={Send} title="No campaigns yet"
                description="Select leads on the All leads page and choose Email, WhatsApp or Both — the batch appears here with live progress."
                action={<Link to="/leads"><Button variant="secondary">Go to leads</Button></Link>} />
            </Surface>
          ) : (
            <div className="space-y-3">
              {campaigns.map((c) => (
                <CampaignCard key={c.id} campaign={c} defaultOpen={c.id === focusCampaign} />
              ))}
            </div>
          )}
        </div>

        {/* ── Replies feed ─────────────────────────────────────────────────── */}
        <Surface className="p-5">
          <SectionHeading
            icon={Reply}
            title="Replies"
            description="Every answer that came back, newest first."
            actions={<Link to="/inbox" className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline">Open inbox<ArrowRight size={11} /></Link>}
          />
          {stats.recentReplies.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--text-muted)]">
              No replies yet — they land here (and in the Inbox) as soon as someone answers.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {stats.recentReplies.map((r) => (
                <li key={r.id} className="py-3 first:pt-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {r.leadId
                          ? <Link to={`/leads/${r.leadId}`} className="text-[13px] font-medium hover:text-[var(--accent)] hover:underline">{r.company}</Link>
                          : <span className="text-[13px] font-medium">{r.company}</span>}
                        <Badge tone={r.channel === "WHATSAPP" ? "var(--color-positive)" : "var(--accent)"}>
                          {r.channel === "WHATSAPP" ? "WhatsApp" : "Email"}
                        </Badge>
                        {r.city && <span className="text-[11px] text-[var(--text-subtle)]">{r.city}</span>}
                      </div>
                      <p className="mt-1 line-clamp-2 text-[13px] leading-snug text-[var(--text-muted)]">{r.snippet || r.subject}</p>
                    </div>
                    <span className="shrink-0 text-[11px] text-[var(--text-subtle)]">{formatDateTime(r.receivedAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Surface>
      </PageBody>
    </div>
  );
}

const Stat = ({ icon: Icon, label, value, sub, tone }) => (
  <Surface className="p-4">
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>
      <Icon size={14} style={{ color: tone || "var(--text-subtle)" }} />
    </div>
    <p className="tnum mt-2 text-2xl font-semibold tracking-tight" style={tone ? { color: tone } : undefined}>{value}</p>
    {sub && <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">{sub}</p>}
  </Surface>
);

const CampaignCard = ({ campaign, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  const queryClient = useQueryClient();
  const wantEmail = campaign.channels.includes("EMAIL");
  const wantWa = campaign.channels.includes("WHATSAPP");

  const act = useMutation({
    mutationFn: ({ action }) => api[`${action}Campaign`](campaign.id),
    onSuccess: (_, { action }) => {
      toast.success(`Campaign ${action === "cancel" ? "cancelled" : `${action}d`}.`);
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const { data: detail } = useQuery({
    queryKey: ["campaign-detail", campaign.id],
    queryFn: () => api.getCampaign(campaign.id),
    enabled: open,
    refetchInterval: campaign.status === "RUNNING" ? 6_000 : false,
  });

  const channelBar = (label, Icon, s) => {
    const done = s.sent + s.skipped + s.failed;
    const total = done + s.pending;
    if (total === 0) return null;
    return (
      <div>
        <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--text-muted)]">
          <span className="inline-flex items-center gap-1"><Icon size={10} />{label}</span>
          <span className="tnum">{s.sent} sent · {s.skipped} skipped{s.failed ? ` · ${s.failed} failed` : ""}{s.pending ? ` · ${s.pending} to go` : ""}</span>
        </div>
        <div className="flex h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
          <div style={{ width: `${(s.sent / total) * 100}%`, background: "var(--color-positive)" }} />
          <div style={{ width: `${(s.failed / total) * 100}%`, background: "var(--color-critical)" }} />
          <div style={{ width: `${(s.skipped / total) * 100}%`, background: "var(--color-ink-400)" }} />
        </div>
      </div>
    );
  };

  return (
    <Surface className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <button onClick={() => setOpen((v) => !v)} className="flex min-w-0 items-start gap-2 text-left">
          {open ? <ChevronDown size={14} className="mt-1 shrink-0 text-[var(--text-subtle)]" /> : <ChevronRight size={14} className="mt-1 shrink-0 text-[var(--text-subtle)]" />}
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium">{campaign.name}</span>
            <span className="block text-[11px] text-[var(--text-subtle)]">
              {campaign.total} leads · {campaign.mode === "AUTO"
                ? `auto · ≤${campaign.dailyLimit}/day, ${String(campaign.windowStart).padStart(2, "0")}:00–${String(campaign.windowEnd).padStart(2, "0")}:00`
                : `every ${campaign.paceSeconds}s`} · started {formatDateTime(campaign.createdAt)}
              {/* Every message this queue sends is recorded against whoever
                  launched it, so the run is as attributable as a typed email. */}
              {campaign.createdByName && ` by ${campaign.createdByName}`}
            </span>
          </span>
        </button>

        <div className="flex items-center gap-1.5">
          {wantEmail && <Badge><Mail size={10} />Email</Badge>}
          {wantWa && <Badge><MessageCircle size={10} />WhatsApp</Badge>}
          <Badge tone={CAMPAIGN_TONE[campaign.status]}>{titleize(campaign.status)}</Badge>
          {campaign.status === "RUNNING" && (
            <Button size="sm" variant="ghost" onClick={() => act.mutate({ action: "pause" })} aria-label="Pause"><Pause size={13} /></Button>
          )}
          {campaign.status === "PAUSED" && (
            <Button size="sm" variant="ghost" onClick={() => act.mutate({ action: "resume" })} aria-label="Resume"><Play size={13} /></Button>
          )}
          {["RUNNING", "PAUSED"].includes(campaign.status) && (
            <Button size="sm" variant="ghost" onClick={() => act.mutate({ action: "cancel" })} aria-label="Cancel"><XCircle size={13} /></Button>
          )}
        </div>
      </div>

      {/* Why it stopped. A campaign the bounce guard paused must say so, or the
          obvious response is to press Resume and trip it again next tick. */}
      {campaign.status === "PAUSED" && campaign.pausedReason && (
        <p className="mt-3 flex items-start gap-2 rounded-lg border border-[color-mix(in_oklch,var(--color-caution)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-caution)_8%,transparent)] p-2.5 text-[11px] leading-relaxed text-[var(--text-muted)]">
          <AlertTriangle size={12} className="mt-px shrink-0 text-[var(--color-caution)]" />
          <span>{campaign.pausedReason}</span>
        </p>
      )}

      <div className="mt-3 space-y-2">
        {wantEmail && channelBar("Email", Mail, campaign.email)}
        {wantWa && channelBar("WhatsApp", MessageCircle, campaign.whatsapp)}
      </div>

      {open && detail && (
        <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-left text-[12px]">
            <thead className="sticky top-0 bg-[var(--surface-sunken)] text-[10px] uppercase tracking-wide text-[var(--text-subtle)]">
              <tr>
                <th className="px-3 py-2 font-medium">Lead</th>
                {wantEmail && <th className="px-3 py-2 font-medium">Email</th>}
                {wantWa && <th className="px-3 py-2 font-medium">WhatsApp</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {detail.recipients.map((r) => (
                <tr key={r.leadId}>
                  <td className="px-3 py-2">
                    <Link to={`/leads/${r.leadId}`} className="font-medium hover:text-[var(--accent)] hover:underline">{r.company}</Link>
                    {r.city && <span className="ml-1.5 text-[var(--text-subtle)]">{r.city}</span>}
                  </td>
                  {wantEmail && <RecipientCell state={r.email} />}
                  {wantWa && <RecipientCell state={r.whatsapp} />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Surface>
  );
};

const CELL_TONE = { SENT: "var(--color-positive)", PENDING: "var(--accent)", SKIPPED: "var(--color-ink-400)", FAILED: "var(--color-critical)" };
const RecipientCell = ({ state }) => (
  <td className="px-3 py-2">
    <span title={state.detail || undefined} className="inline-flex items-center gap-1.5">
      <span className="size-1.5 rounded-full" style={{ background: CELL_TONE[state.state] }} />
      <span className="text-[var(--text-muted)]">{titleize(state.state)}</span>
    </span>
  </td>
);
