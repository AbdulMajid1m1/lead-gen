import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Inbox as InboxIcon, Mail, MessageCircle, RefreshCw, Send, ArrowRight,
  ThumbsUp, ThumbsDown, Info, Clock,
} from "lucide-react";
import { toast } from "sonner";
import { PageBody, PageHeader } from "../App.jsx";
import { api } from "../lib/api.js";
import { Badge, Button, EmptyState, ErrorState, Skeleton, Surface } from "../components/ui.jsx";
import {
  INBOX_BUCKETS, STATUS_LABELS, STATUS_TONE, SERVICE_LABELS,
  relativeTime, relativeShort, scoreTone, cn,
} from "../lib/format.js";

/**
 * The Inbox.
 *
 * Every other screen in this app answers "who is worth contacting?". This one
 * answers the question that comes after: "of everyone I already contacted, who
 * needs me today?" — and it answers it without the user having to remember
 * anything, because the buckets are derived from thread state on the server.
 *
 * The ordering is the whole design: replies first (a person is waiting), then
 * chases that have come due, then everything that is simply in flight. If the
 * top of this page is empty, the day's outreach is genuinely clear.
 */

const BUCKET_ORDER = ["replied", "due", "waiting", "silent", "closed"];

const CHANNEL_META = {
  EMAIL: { icon: Mail, label: "Email" },
  WHATSAPP: { icon: MessageCircle, label: "WhatsApp" },
};

/** Filter chip — a bucket tab, or the channel toggle. Same shape for both. */
const Chip = ({ active, tone, count, children, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={cn(
      "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[13px] font-medium transition-colors",
      active
        ? "border-transparent shadow-[var(--shadow-xs)]"
        : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
    )}
    style={active ? { backgroundColor: `color-mix(in oklch, ${tone} 15%, transparent)`, color: tone } : undefined}
  >
    {children}
    {count !== undefined && (
      <span className={cn("tnum text-[11px]", !active && "text-[var(--text-subtle)]")}>{count}</span>
    )}
  </button>
);

/**
 * The one line that says why this thread is on screen right now. Written as a
 * sentence rather than a set of fields, because "no reply for 6 days" is read
 * faster than "sent: 6 days ago · replies: 0".
 */
const whyItsHere = (thread) => {
  const last = thread.messages?.[0];
  switch (thread.bucket) {
    case "replied":
      return `Replied ${relativeTime(thread.repliedAt)} — waiting on you`;
    case "due":
      return thread.followUpsSent > 0
        ? `Follow-up #${thread.followUpsSent + 1} due ${relativeTime(thread.nextFollowUpAt)}`
        : `First follow-up due ${relativeTime(thread.nextFollowUpAt)}`;
    case "waiting":
      return thread.nextFollowUpAt
        ? `Sent ${relativeTime(thread.lastOutboundAt)} · next chase ${relativeTime(thread.nextFollowUpAt)}`
        : `Sent ${relativeTime(thread.lastOutboundAt)} · no chase scheduled`;
    case "silent":
      return `${thread.followUpsSent} follow-up${thread.followUpsSent === 1 ? "" : "s"} sent, no reply since ${relativeTime(thread.lastOutboundAt)}`;
    default:
      return last ? `Last activity ${relativeTime(last.createdAt)}` : "No activity";
  }
};

const ThreadRow = ({ thread, onFollowUp, onJudge, busy }) => {
  const bucket = INBOX_BUCKETS[thread.bucket] || INBOX_BUCKETS.waiting;
  const Channel = (CHANNEL_META[thread.channel] || CHANNEL_META.EMAIL).icon;
  const lead = thread.lead;
  const last = thread.messages?.[0];
  const sender = thread.account?.email || thread.waAccount?.label;
  // Which mailbox it left from answers "how"; this answers "who" — the two came
  // apart the moment more than one person could send from the same inbox.
  const owner = thread.startedBy?.name || thread.startedBy?.email || thread.startedByName;

  // Only the newest inbound message is worth quoting — an outbound preview is
  // just our own copy read back to us.
  const quote = last?.direction === "INBOUND" ? last.body : null;

  return (
    <Surface
      className={cn(
        "p-4 transition-colors hover:border-[var(--border-strong)]",
        thread.bucket === "replied" && "border-[color-mix(in_oklch,var(--accent)_35%,var(--border))]",
      )}
    >
      <div className="flex gap-3.5">
        <div
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `color-mix(in oklch, ${bucket.tone} 14%, transparent)`, color: bucket.tone }}
          title={(CHANNEL_META[thread.channel] || CHANNEL_META.EMAIL).label}
        >
          <Channel size={15} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              to={`/leads/${thread.leadId}`}
              className="truncate text-[15px] font-semibold tracking-tight hover:text-[var(--accent)]"
            >
              {lead?.company?.name || "Unknown company"}
            </Link>
            {lead && (
              <Badge tone={scoreTone(lead.score)} className="tnum">{lead.score}</Badge>
            )}
            <Badge tone={bucket.tone}>{bucket.label}</Badge>
            {lead && lead.status !== "REPLIED" && (
              <Badge tone={STATUS_TONE[lead.status]}>{STATUS_LABELS[lead.status] || lead.status}</Badge>
            )}
            <span className="tnum ml-auto shrink-0 text-[11px] text-[var(--text-subtle)]">
              {relativeShort(thread.bucket === "due" ? thread.nextFollowUpAt : thread.repliedAt || thread.lastOutboundAt)}
            </span>
          </div>

          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {whyItsHere(thread)}
          </p>

          <p className="mt-0.5 truncate text-[11px] text-[var(--text-subtle)]">
            {thread.recipientEmail}
            {sender && ` · via ${sender}`}
            {owner && ` · by ${owner}`}
            {lead?.primaryOpportunity && ` · ${SERVICE_LABELS[lead.primaryOpportunity] || lead.primaryOpportunity}`}
          </p>

          {quote && (
            <blockquote className="mt-2.5 border-l-2 border-[color-mix(in_oklch,var(--accent)_45%,transparent)] bg-[var(--surface-sunken)] px-3 py-2 text-[13px] leading-snug text-[var(--text)]">
              <span className="line-clamp-3">{quote}</span>
            </blockquote>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link
              to={`/leads/${thread.leadId}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-xs font-medium shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--surface-sunken)]"
            >
              Open lead <ArrowRight size={12} />
            </Link>

            {thread.bucket === "replied" && (
              <>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => onJudge(thread, "INTERESTED")}>
                  <ThumbsUp size={12} />Interested
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => onJudge(thread, "NOT_INTERESTED")}>
                  <ThumbsDown size={12} />Not interested
                </Button>
              </>
            )}

            {(thread.bucket === "due" || thread.bucket === "waiting") && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => onFollowUp(thread)}>
                <Send size={12} />Send follow-up now
              </Button>
            )}
          </div>
        </div>
      </div>
    </Surface>
  );
};

export default function InboxPage() {
  const [bucket, setBucket] = useState("");
  const [channel, setChannel] = useState("");
  const queryClient = useQueryClient();

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["outreach-inbox", bucket, channel],
    queryFn: () => api.outreachInbox({ bucket, channel }),
    // Replies arrive while the page is open; a quiet refresh beats a stale queue.
    refetchInterval: 60_000,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["outreach-inbox"] });
    queryClient.invalidateQueries({ queryKey: ["leads"] });
    queryClient.invalidateQueries({ queryKey: ["outreach-threads"] });
  };

  const syncMutation = useMutation({
    mutationFn: () => api.syncOutreach(),
    onSuccess: (result, _v, _c) => { toast.success(result?.message || "Sync complete."); refresh(); },
    onError: (err) => toast.error(err.message),
  });

  const followUpMutation = useMutation({
    mutationFn: (thread) => api.sendFollowUpNow(thread.id),
    onSuccess: () => { toast.success("Follow-up sent."); refresh(); },
    onError: (err) => toast.error(err.message),
  });

  const judgeMutation = useMutation({
    mutationFn: ({ thread, status }) => api.updateLeadStatus(thread.leadId, { status }),
    onSuccess: (_r, { status }) => {
      toast.success(`Marked ${STATUS_LABELS[status].toLowerCase()}`);
      refresh();
    },
    onError: (err) => toast.error(err.message),
  });

  const counts = data?.counts || {};
  const threads = data?.threads || [];
  // Counts always cover the whole set, so the chips keep their totals while one
  // bucket is selected — a filter should never make the other numbers vanish.
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const busy = followUpMutation.isPending || judgeMutation.isPending;

  // Nothing will ever be sent on its own. Worth saying out loud, because an
  // empty "due" bucket otherwise looks like everything is under control.
  const automation = data?.automation;
  const automationOff =
    automation &&
    automation.emailAccountsAutoFollowUp === 0 &&
    automation.whatsappDevicesAutoFollowUp === 0;

  return (
    <div>
      <PageHeader
        title="Inbox"
        description="Everyone you have already contacted, sorted by who needs you first. Replies come to the top; follow-ups appear on the day they are due."
        actions={
          <Button
            variant="secondary"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
          >
            <RefreshCw size={14} className={cn(syncMutation.isPending && "animate-spin")} />
            {syncMutation.isPending ? "Checking…" : "Check for replies"}
          </Button>
        }
      />

      <PageBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Chip active={!bucket} tone="var(--text)" count={total} onClick={() => setBucket("")}>
            Everything
          </Chip>
          {BUCKET_ORDER.map((key) => (
            <Chip
              key={key}
              active={bucket === key}
              tone={INBOX_BUCKETS[key].tone}
              count={counts[key] ?? 0}
              onClick={() => setBucket(bucket === key ? "" : key)}
            >
              {INBOX_BUCKETS[key].label}
            </Chip>
          ))}

          <span className="mx-1 hidden h-5 w-px bg-[var(--border)] sm:block" />

          {[["", "All channels"], ["EMAIL", "Email"], ["WHATSAPP", "WhatsApp"]].map(([value, label]) => (
            <Chip key={value || "all"} active={channel === value} tone="var(--color-info)" onClick={() => setChannel(value)}>
              {label}
            </Chip>
          ))}
        </div>

        {bucket && (
          <p className="flex items-start gap-2 text-xs text-[var(--text-muted)]">
            <Info size={13} className="mt-px shrink-0 text-[var(--text-subtle)]" />
            {INBOX_BUCKETS[bucket].hint}
          </p>
        )}

        {automationOff && (
          <Surface className="flex items-start gap-2.5 border-[color-mix(in_oklch,var(--color-caution)_35%,var(--border))] p-3">
            <Clock size={14} className="mt-0.5 shrink-0 text-[var(--color-caution)]" />
            <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">
              <span className="font-medium text-[var(--text)]">Automatic follow-ups are off.</span>{" "}
              Due chases will sit here until you send them by hand. Turn them on per mailbox or per
              WhatsApp device in <Link to="/settings" className="text-[var(--accent)] hover:underline">Settings</Link>.
            </p>
          </Surface>
        )}

        {isPending && <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}</div>}
        {isError && <ErrorState error={error} onRetry={refetch} />}

        {data && threads.length === 0 && (
          <Surface className="border-dashed">
            <EmptyState
              icon={InboxIcon}
              title={bucket ? `Nothing in ${INBOX_BUCKETS[bucket].label.toLowerCase()}` : "Your inbox is clear"}
              description={
                bucket
                  ? INBOX_BUCKETS[bucket].blurb
                  : "No outreach threads yet. Open a lead and send the first email or WhatsApp message to start tracking replies here."
              }
              action={<Link to="/leads"><Button variant="secondary" size="sm">Browse leads</Button></Link>}
            />
          </Surface>
        )}

        {threads.length > 0 && (
          <div className="space-y-3">
            {threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                busy={busy}
                onFollowUp={(t) => followUpMutation.mutate(t)}
                onJudge={(t, status) => judgeMutation.mutate({ thread: t, status })}
              />
            ))}
          </div>
        )}
      </PageBody>
    </div>
  );
}
