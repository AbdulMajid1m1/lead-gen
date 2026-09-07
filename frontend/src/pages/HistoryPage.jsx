import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  History, Mail, MessageCircle, ArrowUpRight, ArrowDownLeft, Bot, User, Search,
  ChevronDown, ChevronUp, ArrowRight, CornerUpLeft, RefreshCw, AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { PageBody, PageHeader } from "../App.jsx";
import { api } from "../lib/api.js";
import {
  Badge, Button, EmptyState, ErrorState, Input, Select, Skeleton, Spinner, Surface, Textarea,
} from "../components/ui.jsx";
import { STATUS_LABELS, STATUS_TONE, cn, formatDateTime, relativeTime, scoreTone } from "../lib/format.js";

/**
 * Everything that has been said, in both directions, on both channels.
 *
 * The Inbox is a queue — what needs answering now, one row per conversation.
 * This is the ledger, and the difference is deliberate: one row per *message*,
 * so a lane that sent forty emails yesterday reads as forty here. The question
 * it answers is "what went out today, and who sent it", which is why the day
 * strip sits at the top and every row names its sender.
 */

const KIND_META = {
  INITIAL: { label: "First message", tone: undefined },
  FOLLOW_UP: { label: "Follow-up", tone: undefined },
  REPLY: { label: "Reply", tone: "var(--accent)" },
  BOUNCE: { label: "Bounce", tone: "var(--color-critical)" },
  AUTO_REPLY: { label: "Auto-reply", tone: "var(--color-caution)" },
};

const DAY_FILTERS = [
  { value: "1", label: "Today" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "", label: "All time" },
];

/**
 * The calendar day an instant falls on *where the viewer is*. The server groups
 * its totals the same way, so the header figures and the rows below them agree
 * — a message at 22:00 UTC belongs to the next day in Dubai, and counting it
 * under the UTC day would leave the strip and the list disagreeing by one.
 */
const localDay = (value) => {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

const dayLabel = (iso) => {
  if (iso === localDay(Date.now())) return "Today";
  if (iso === localDay(Date.now() - 86_400_000)) return "Yesterday";
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
};

/** The headline figures, and the fourteen days behind them. */
const DayStrip = ({ daily, today }) => {
  const peak = Math.max(1, ...daily.map((d) => d.total));
  return (
    <Surface className="p-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap gap-5">
          <Figure label="Emails today" value={today.emailSent} icon={Mail} />
          <Figure label="WhatsApp today" value={today.whatsappSent} icon={MessageCircle} />
          <Figure label="Replies today" value={today.replies} icon={CornerUpLeft} tone={today.replies ? "positive" : undefined} />
        </div>
        <p className="text-[11px] text-[var(--text-subtle)]">Last 14 days · your local days</p>
      </div>

      <div className="mt-5 flex items-end gap-1.5" role="img" aria-label="Messages sent per day over the last 14 days">
        {[...daily].reverse().map((d) => (
          <div key={d.day} className="group flex min-w-0 flex-1 flex-col items-center gap-1">
            <div
              className="flex w-full flex-col justify-end rounded-sm"
              style={{ height: 56 }}
              title={`${dayLabel(d.day)} — ${d.emailSent} email, ${d.whatsappSent} WhatsApp, ${d.replies} replies`}
            >
              {d.whatsappSent > 0 && (
                <div
                  className="w-full rounded-t-sm bg-[color-mix(in_oklch,var(--color-positive)_70%,transparent)]"
                  style={{ height: `${(d.whatsappSent / peak) * 100}%` }}
                />
              )}
              {d.emailSent > 0 && (
                <div
                  className={cn("w-full bg-[var(--accent)]", d.whatsappSent === 0 && "rounded-t-sm")}
                  style={{ height: `${(d.emailSent / peak) * 100}%` }}
                />
              )}
              {d.total === 0 && <div className="w-full rounded-sm bg-[var(--border)]" style={{ height: 2 }} />}
            </div>
            <span className="w-full truncate text-center text-[10px] text-[var(--text-subtle)]">
              {d.day.slice(8)}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4 text-[11px] text-[var(--text-subtle)]">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-[var(--accent)]" /> Email
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-[color-mix(in_oklch,var(--color-positive)_70%,transparent)]" /> WhatsApp
        </span>
      </div>
    </Surface>
  );
};

const Figure = ({ label, value, icon: Icon, tone }) => (
  <div>
    <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">
      <Icon size={12} />{label}
    </div>
    <div className={cn("mt-0.5 text-2xl font-semibold tabular-nums", tone === "positive" && "text-[var(--color-positive)]")}>
      {value}
    </div>
  </div>
);

/** One message, expandable into the whole conversation with a reply box. */
const MessageRow = ({ row, expanded, onToggle }) => {
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const outbound = row.direction === "OUTBOUND";
  const kind = KIND_META[row.kind] || { label: row.kind };
  const Channel = row.channel === "WHATSAPP" ? MessageCircle : Mail;
  const Arrow = outbound ? ArrowUpRight : ArrowDownLeft;

  const thread = useQuery({
    queryKey: ["outreach", "history", "thread", row.threadId],
    queryFn: () => api.outreachHistory({ leadId: row.lead?.id, perPage: 100 }),
    enabled: expanded && Boolean(row.lead?.id),
  });

  const reply = useMutation({
    mutationFn: () => api.replyToThread(row.threadId, { body: draft.trim() }),
    onSuccess: () => {
      setDraft("");
      toast.success("Reply sent.");
      qc.invalidateQueries({ queryKey: ["outreach", "history"] });
    },
    onError: (err) => toast.error(err.message || "Could not send."),
  });

  // Only this thread's messages, oldest first — the shape a conversation reads in.
  const conversation = useMemo(() => {
    const all = thread.data?.messages || [];
    return all.filter((m) => m.threadId === row.threadId).slice().reverse();
  }, [thread.data, row.threadId]);

  const canReply = row.thread?.status !== "BOUNCED";

  return (
    <Surface className={cn("p-4", row.kind === "BOUNCE" && "border-[color-mix(in_oklch,var(--color-critical)_35%,var(--border))]")}>
      <div className="flex gap-3.5">
        <div
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
            outbound ? "bg-[color-mix(in_oklch,var(--accent)_14%,transparent)] text-[var(--accent)]"
              : "bg-[var(--surface-sunken)] text-[var(--text-muted)]",
          )}
          title={`${row.channel === "WHATSAPP" ? "WhatsApp" : "Email"} · ${outbound ? "sent" : "received"}`}
        >
          <Channel size={15} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {row.lead
              ? (
                <Link to={`/leads/${row.lead.id}`} className="truncate text-[15px] font-semibold tracking-tight hover:text-[var(--accent)]">
                  {row.lead.company}
                </Link>
              )
              : <span className="text-[15px] font-semibold">Unknown company</span>}
            {row.lead && <Badge tone={scoreTone(row.lead.score)} className="tnum">{row.lead.score}</Badge>}
            <Badge tone={kind.tone}>{kind.label}</Badge>
            {row.lead?.product && <Badge>{row.lead.product}</Badge>}
            {row.lead && <Badge tone={STATUS_TONE[row.lead.status]}>{STATUS_LABELS[row.lead.status] || row.lead.status}</Badge>}
            <span className="tnum ml-auto shrink-0 text-[11px] text-[var(--text-subtle)]" title={formatDateTime(row.at)}>
              {relativeTime(row.at)}
            </span>
          </div>

          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[var(--text-subtle)]">
            <Arrow size={11} />
            {outbound
              ? (
                <>
                  <span>to {row.recipient}</span>
                  {row.sender && <span>· via {row.sender.label}</span>}
                  <span className="inline-flex items-center gap-1">
                    ·{row.sentBy?.type === "PERSON" ? <User size={10} /> : <Bot size={10} />}
                    {row.sentBy?.name}
                  </span>
                </>
              )
              : <span>from {row.fromAddress || row.recipient}</span>}
            {row.bounce && <span>· {row.bounce.code}</span>}
          </p>

          {row.subject && row.channel !== "WHATSAPP" && (
            <p className="mt-2 text-[13px] font-medium">{row.subject}</p>
          )}

          {expanded
            ? (
              <div className="mt-2 space-y-3">
                <pre className="whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2.5 font-sans text-[13px] leading-snug">
                  {row.body}
                </pre>

                {thread.isLoading && <Skeleton className="h-16 w-full" />}
                {conversation.length > 1 && (
                  <div>
                    <p className="mb-1.5 text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">
                      Whole conversation ({conversation.length})
                    </p>
                    <div className="space-y-1.5">
                      {conversation.map((m) => (
                        <div
                          key={m.id}
                          className={cn(
                            "rounded-lg border px-3 py-2 text-[13px] leading-snug",
                            m.id === row.id && "ring-1 ring-[var(--accent)]",
                            m.direction === "OUTBOUND"
                              ? "border-[color-mix(in_oklch,var(--accent)_25%,var(--border))] bg-[color-mix(in_oklch,var(--accent)_5%,transparent)]"
                              : "border-[var(--border)] bg-[var(--surface-sunken)]",
                          )}
                        >
                          <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--text-subtle)]">
                            <span className="font-medium text-[var(--text-muted)]">
                              {(KIND_META[m.kind] || {}).label || m.kind}
                            </span>
                            {m.direction === "OUTBOUND" && m.sentBy && <span>by {m.sentBy.name}</span>}
                            <span className="ml-auto tnum" title={formatDateTime(m.at)}>{relativeTime(m.at)}</span>
                          </div>
                          <pre className="mt-1 whitespace-pre-wrap break-words font-sans">{m.body}</pre>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {canReply
                  ? (
                    <div>
                      <Textarea
                        rows={3}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder={row.channel === "WHATSAPP"
                          ? `Reply on WhatsApp to ${row.lead?.company || "this lead"}…`
                          : `Reply to ${row.recipient}…`}
                        aria-label="Your reply"
                      />
                      <div className="mt-1.5 flex items-center gap-2">
                        <Button
                          size="sm"
                          disabled={!draft.trim() || reply.isPending}
                          onClick={() => reply.mutate()}
                        >
                          {reply.isPending ? <Spinner size={13} /> : <CornerUpLeft size={13} />} Send reply
                        </Button>
                        <span className="text-[11px] text-[var(--text-subtle)]">
                          Goes out from {row.sender?.label || "the same sender"}, in this conversation.
                          Replying by hand stops the automatic follow-ups.
                        </span>
                      </div>
                    </div>
                  )
                  : (
                    <p className="flex items-start gap-1 text-[11px] text-[var(--text-subtle)]">
                      <AlertTriangle size={12} className="mt-px shrink-0" />
                      The last message here bounced, so this address is not worth another send.
                    </p>
                  )}
              </div>
            )
            : (
              <p className="mt-1.5 line-clamp-2 text-[13px] text-[var(--text-muted)]">{row.body}</p>
            )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {expanded ? "Hide" : "Open message"}
            </button>
            {row.lead && (
              <Link
                to={`/leads/${row.lead.id}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-xs font-medium shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--surface-sunken)]"
              >
                Open lead <ArrowRight size={12} />
              </Link>
            )}
          </div>
        </div>
      </div>
    </Surface>
  );
};

export default function HistoryPage() {
  const [filters, setFilters] = useState({
    channel: "", direction: "", sentBy: "", days: "7", search: "",
  });
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState(null);
  const [term, setTerm] = useState("");

  const params = useMemo(() => ({
    ...(filters.channel ? { channel: filters.channel } : {}),
    ...(filters.direction ? { direction: filters.direction } : {}),
    ...(filters.sentBy ? { sentBy: filters.sentBy } : {}),
    ...(filters.days ? { days: filters.days } : {}),
    ...(filters.search ? { search: filters.search } : {}),
    page,
    perPage: 50,
    // The server groups days on this, so "today" is the viewer's today.
    tzOffsetMinutes: -new Date().getTimezoneOffset(),
  }), [filters, page]);

  const { data, isPending, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["outreach", "history", params],
    queryFn: () => api.outreachHistory(params),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const set = (key) => (value) => { setFilters((f) => ({ ...f, [key]: value })); setPage(1); };
  const messages = data?.messages || [];

  // A date header before the first row of each day, so a day's work reads as
  // a block rather than as a list that happens to be in order.
  const grouped = useMemo(() => {
    const out = [];
    let last = null;
    for (const m of messages) {
      const day = localDay(m.at);
      if (day !== last) { out.push({ type: "day", day }); last = day; }
      out.push({ type: "message", row: m });
    }
    return out;
  }, [messages]);

  return (
    <div>
      <PageHeader
        title="History"
        description="Every email and WhatsApp message this console has sent or received, newest first — who sent it, when, and what came back."
        actions={
          <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Spinner size={14} /> : <RefreshCw size={14} />} Refresh
          </Button>
        }
      />

      <PageBody className="space-y-4">
        {isPending && <Skeleton className="h-40 w-full rounded-xl" />}
        {isError && <Surface><ErrorState error={error} onRetry={refetch} /></Surface>}

        {data && (
          <>
            <DayStrip daily={data.daily || []} today={data.today || {}} />

            <Surface className="p-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <label className="block lg:col-span-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Search</span>
                  <div className="relative mt-1">
                    <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-subtle)]" />
                    <Input
                      className="w-full pl-8"
                      value={term}
                      placeholder="Company or address"
                      onChange={(e) => setTerm(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") set("search")(term.trim()); }}
                      onBlur={() => set("search")(term.trim())}
                    />
                  </div>
                </label>

                <Field label="Channel" value={filters.channel} onChange={set("channel")} options={[
                  { value: "", label: "Email and WhatsApp" },
                  { value: "EMAIL", label: "Email only" },
                  { value: "WHATSAPP", label: "WhatsApp only" },
                ]} />

                <Field label="Sent by" value={filters.sentBy} onChange={set("sentBy")} options={[
                  { value: "", label: "Anyone" },
                  { value: "AUTOMATION", label: "Autopilot" },
                  { value: "PERSON", label: "A person" },
                ]} />

                <Field label="Period" value={filters.days} onChange={set("days")} options={DAY_FILTERS} />
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                {[
                  { value: "", label: "Everything" },
                  { value: "OUTBOUND", label: "Sent" },
                  { value: "INBOUND", label: "Received" },
                ].map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => set("direction")(opt.value)}
                    aria-pressed={filters.direction === opt.value}
                    className={cn(
                      "rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
                      filters.direction === opt.value
                        ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                        : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]",
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
                <span className="ml-auto text-[11px] text-[var(--text-subtle)]">
                  {data.total} message{data.total === 1 ? "" : "s"} match
                </span>
              </div>
            </Surface>

            {messages.length === 0
              ? (
                <Surface>
                  <EmptyState
                    icon={History}
                    title="Nothing in this period"
                    description="Widen the period or clear the filters. Automatic sends appear here the minute they go out."
                  />
                </Surface>
              )
              : (
                <div className="space-y-2.5">
                  {grouped.map((item) => (
                    item.type === "day"
                      ? (
                        <h2 key={`day-${item.day}`} className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                          {dayLabel(item.day)}
                        </h2>
                      )
                      : (
                        <MessageRow
                          key={item.row.id}
                          row={item.row}
                          expanded={openId === item.row.id}
                          onToggle={() => setOpenId(openId === item.row.id ? null : item.row.id)}
                        />
                      )
                  ))}
                </div>
              )}

            {(page > 1 || data.hasMore) && (
              <div className="flex items-center justify-between">
                <Button variant="secondary" size="sm" disabled={page === 1 || isFetching} onClick={() => setPage((p) => p - 1)}>
                  Newer
                </Button>
                <span className="text-[11px] text-[var(--text-subtle)]">Page {page}</span>
                <Button variant="secondary" size="sm" disabled={!data.hasMore || isFetching} onClick={() => setPage((p) => p + 1)}>
                  Older
                </Button>
              </div>
            )}
          </>
        )}
      </PageBody>
    </div>
  );
}

const Field = ({ label, value, onChange, options }) => (
  <label className="block">
    <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">{label}</span>
    <Select className="mt-1 w-full" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Select>
  </label>
);
