import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare, ArrowRight, ChevronDown, ChevronUp, Mail, MessageCircle, ArrowUpRight, ArrowDownLeft } from "lucide-react";
import { api } from "../lib/api.js";
import { Badge, Skeleton, Surface, SectionHeading, EmptyState } from "./ui.jsx";
import { INBOX_BUCKETS, STATUS_LABELS, STATUS_TONE, cn, formatDateTime, relativeTime, scoreTone } from "../lib/format.js";

/**
 * Every lead this product has written to, with the whole exchange.
 *
 * The Leads tab answers "who is in the pipeline"; this answers "what did we
 * actually say to them, and what came back". A row is one conversation: the
 * company, where it stands, and the latest message. Opening it shows each
 * message in order — ours and theirs — and the lead itself is one click away.
 */

const BUCKETS = ["replied", "due", "waiting", "silent", "closed"];

const KIND_LABEL = {
  INITIAL: "First email",
  FOLLOW_UP: "Follow-up",
  REPLY: "Reply",
  BOUNCE: "Bounce",
  AUTO_REPLY: "Auto-reply",
};

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
    {count !== undefined && <span className={cn("tnum text-[11px]", !active && "text-[var(--text-subtle)]")}>{count}</span>}
  </button>
);

/** One message in the exchange. Ours sit on the right, theirs on the left. */
const Message = ({ message }) => {
  const ours = message.direction === "OUTBOUND";
  const when = message.sentAt || message.receivedAt || message.createdAt;
  const Icon = ours ? ArrowUpRight : ArrowDownLeft;
  return (
    <div className={cn("flex", ours ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "w-full max-w-[85%] rounded-lg border px-3 py-2.5 text-[13px] leading-snug",
          ours
            ? "border-[color-mix(in_oklch,var(--accent)_30%,var(--border))] bg-[color-mix(in_oklch,var(--accent)_6%,var(--surface-raised))]"
            : "border-[var(--border)] bg-[var(--surface-sunken)]",
        )}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--text-subtle)]">
          <Icon size={11} />
          <span className="font-medium text-[var(--text-muted)]">{KIND_LABEL[message.kind] || message.kind}</span>
          {ours
            ? (message.sentByName || message.sentBy?.name) && <span>by {message.sentByName || message.sentBy?.name}</span>
            : message.fromAddress && <span>from {message.fromAddress}</span>}
          <span className="ml-auto tnum" title={formatDateTime(when)}>{relativeTime(when)}</span>
        </div>
        {message.subject && <div className="mt-1 text-[12px] font-semibold">{message.subject}</div>}
        <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[13px] text-[var(--text)]">{message.body}</pre>
      </div>
    </div>
  );
};

const ThreadRow = ({ thread }) => {
  const [open, setOpen] = useState(false);
  const bucket = INBOX_BUCKETS[thread.bucket] || INBOX_BUCKETS.waiting;
  const lead = thread.lead;
  const Channel = thread.channel === "WHATSAPP" ? MessageCircle : Mail;
  // The API returns newest first; a conversation reads top to bottom.
  const messages = [...(thread.messages || [])].reverse();
  const latest = thread.messages?.[0];
  const sent = messages.filter((m) => m.direction === "OUTBOUND").length;
  const received = messages.filter((m) => m.direction === "INBOUND" && m.kind === "REPLY").length;

  return (
    <Surface className={cn("p-4", thread.bucket === "replied" && "border-[color-mix(in_oklch,var(--accent)_35%,var(--border))]")}>
      <div className="flex gap-3.5">
        <div
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `color-mix(in oklch, ${bucket.tone} 14%, transparent)`, color: bucket.tone }}
        >
          <Channel size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link to={`/leads/${thread.leadId}`} className="truncate text-[15px] font-semibold tracking-tight hover:text-[var(--accent)]">
              {lead?.company?.name || "Unknown company"}
            </Link>
            {lead && <Badge tone={scoreTone(lead.score)} className="tnum">{lead.score}</Badge>}
            <Badge tone={bucket.tone}>{bucket.label}</Badge>
            {lead && <Badge tone={STATUS_TONE[lead.status]}>{STATUS_LABELS[lead.status] || lead.status}</Badge>}
            <span className="tnum ml-auto shrink-0 text-[11px] text-[var(--text-subtle)]" title={formatDateTime(thread.updatedAt)}>
              {relativeTime(thread.repliedAt || thread.lastOutboundAt || thread.updatedAt)}
            </span>
          </div>

          <p className="mt-1 truncate text-[11px] text-[var(--text-subtle)]">
            {thread.recipientEmail}
            {thread.account?.email && ` · via ${thread.account.email}`}
            {` · ${sent} sent`}
            {received > 0 && ` · ${received} repl${received === 1 ? "y" : "ies"}`}
            {thread.nextFollowUpAt && thread.status === "AWAITING_REPLY" && ` · next follow-up ${relativeTime(thread.nextFollowUpAt)}`}
          </p>

          {!open && latest && (
            <p className="mt-2 line-clamp-2 text-[13px] text-[var(--text-muted)]">
              <span className="font-medium text-[var(--text)]">{KIND_LABEL[latest.kind] || latest.kind}: </span>
              {latest.subject ? `${latest.subject} — ` : ""}{latest.body}
            </p>
          )}

          {open && (
            <div className="mt-3 space-y-2">
              {messages.map((m) => <Message key={m.id} message={m} />)}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
              aria-expanded={open}
            >
              {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {open ? "Hide conversation" : `Show conversation (${messages.length})`}
            </button>
            <Link
              to={`/leads/${thread.leadId}`}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-xs font-medium shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--surface-sunken)]"
            >
              Open lead <ArrowRight size={12} />
            </Link>
          </div>
        </div>
      </div>
    </Surface>
  );
};

export default function PromoterConversations({ productId }) {
  const [bucket, setBucket] = useState(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ["promoter", productId, "threads", bucket],
    queryFn: () => api.promoterThreads(productId, bucket ? { bucket } : {}),
    refetchInterval: 60_000,
  });

  const counts = data?.counts || {};
  const total = BUCKETS.reduce((sum, b) => sum + (counts[b] || 0), 0);
  const threads = data?.threads || [];

  return (
    <Surface className="p-5">
      <SectionHeading
        icon={MessagesSquare}
        title="Contacted leads"
        description="Everyone this product has written to, with what was sent and what came back. Replies are answered from the lead's page or the Inbox."
      />

      <div className="mt-4 flex flex-wrap gap-1.5">
        <Chip active={bucket === null} tone="var(--text)" count={total} onClick={() => setBucket(null)}>All</Chip>
        {BUCKETS.map((b) => (
          <Chip key={b} active={bucket === b} tone={INBOX_BUCKETS[b].tone} count={counts[b] || 0} onClick={() => setBucket(b)}>
            {INBOX_BUCKETS[b].label}
          </Chip>
        ))}
      </div>

      <div className="mt-4 space-y-2.5">
        {isLoading && <Skeleton className="h-24 w-full" />}
        {error && <p className="text-xs text-[var(--text-subtle)]">Could not load conversations: {error.message}</p>}
        {!isLoading && !error && threads.length === 0 && (
          <EmptyState
            icon={MessagesSquare}
            title={bucket ? `Nothing under "${INBOX_BUCKETS[bucket].label}"` : "No one contacted yet"}
            description={bucket
              ? "Pick another stage, or All."
              : "The first emails appear here the moment the autopilot sends them, and each reply lands under the same company."}
          />
        )}
        {threads.map((t) => <ThreadRow key={t.id} thread={t} />)}
      </div>
    </Surface>
  );
}
