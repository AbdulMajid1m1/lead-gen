import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  X, Copy, Send, RefreshCw, ChevronDown, ChevronRight, Mail, Phone,
  MessageCircle, MapPin, CheckCircle2, Clock, CornerUpLeft, Settings,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { Badge, Button, Input, Select, Spinner, Textarea } from "./ui.jsx";
import { cn, formatDateTime } from "../lib/format.js";

/**
 * The one email surface for a lead: an editable draft (AI when available,
 * template otherwise), one-click send through the connected mailbox, and the
 * conversation that follows — replies pulled by sync, follow-ups tracked.
 */

export const THREAD_STATUS_META = {
  AWAITING_REPLY: { label: "Awaiting reply", tone: "var(--color-caution)", icon: Clock },
  REPLIED: { label: "Replied", tone: "var(--color-positive)", icon: CornerUpLeft },
  CLOSED: { label: "Closed", tone: "var(--text-subtle)", icon: CheckCircle2 },
  BOUNCED: { label: "Bounced", tone: "var(--color-critical)", icon: X },
};

const followUpDue = (t) =>
  t.status === "AWAITING_REPLY" && t.nextFollowUpAt && new Date(t.nextFollowUpAt) <= new Date();

export const ThreadStatusChip = ({ thread }) => {
  if (!thread) return null;
  const due = followUpDue(thread);
  const meta = THREAD_STATUS_META[thread.status] || THREAD_STATUS_META.AWAITING_REPLY;
  const Icon = due ? Clock : meta.icon;
  const tone = due ? "var(--color-info)" : meta.tone;
  return (
    <Badge tone={tone}>
      <Icon size={10} />
      {due ? "Follow-up due" : meta.label}
    </Badge>
  );
};

export default function EmailComposer({ leadId, name, contacts = null, address = null, onClose }) {
  const [showFacts, setShowFacts] = useState(false);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [seededDraftId, setSeededDraftId] = useState(null);
  const queryClient = useQueryClient();

  // Every connected mailbox — the composer picks which one this email goes from.
  const { data: accountData } = useQuery({ queryKey: ["email-accounts"], queryFn: api.listEmailAccounts });
  const accounts = accountData?.accounts || [];
  const [accountId, setAccountId] = useState("");
  const account = accounts.find((a) => a.id === accountId) || accounts.find((a) => a.isDefault) || accounts[0] || null;
  const canSend = account && account.status !== "ERROR";

  const { data: draftsData } = useQuery({
    queryKey: ["email-drafts", leadId],
    queryFn: () => api.listEmailDrafts(leadId),
  });
  const draft = draftsData?.drafts?.[0] || null;

  const { data: threadsData } = useQuery({
    queryKey: ["outreach-threads", leadId],
    queryFn: () => api.listThreads(leadId),
  });
  const threads = threadsData?.threads || [];

  // Email and WhatsApp are two channels over the same lead; each keeps its
  // own conversation thread and the toggle switches the composer between them.
  const [channel, setChannel] = useState("EMAIL");
  const emailThread = threads.find((t) => t.channel !== "WHATSAPP") || null;
  const waThread = threads.find((t) => t.channel === "WHATSAPP") || null;
  const activeThread = channel === "WHATSAPP" ? waThread : emailThread;

  const [waPhone, setWaPhone] = useState("");
  const [waMessage, setWaMessage] = useState("");
  const { data: waStatus } = useQuery({ queryKey: ["whatsapp-status"], queryFn: api.whatsappStatus, refetchInterval: 60_000 });
  const waConnected = Boolean(waStatus?.connected);

  // Seed the editable fields from the newest draft exactly once per draft.
  useEffect(() => {
    if (draft && draft.id !== seededDraftId) {
      setSubject(draft.subject);
      setBody(draft.body);
      setSeededDraftId(draft.id);
    }
  }, [draft, seededDraftId]);
  useEffect(() => {
    if (!to && contacts?.email?.value) setTo(contacts.email.value);
  }, [contacts, to]);
  useEffect(() => {
    const phone = contacts?.whatsapp?.value || contacts?.phone?.value;
    if (!waPhone && phone) setWaPhone(phone);
  }, [contacts, waPhone]);
  useEffect(() => {
    if (draft && !waMessage) setWaMessage(draft.body);
  }, [draft, waMessage]);

  const regenerate = useMutation({
    mutationFn: () => api.regenerateEmailDraft(leadId),
    onSuccess: (data) => {
      toast.success(data?.draft?.generatedBy === "LLM" ? "Rewritten by AI." : "Rewritten from the template (AI unavailable).");
      setSeededDraftId(null); // let the fresh draft repopulate the fields
      setWaMessage("");
      queryClient.invalidateQueries({ queryKey: ["email-drafts", leadId] });
    },
    onError: (err) => toast.error(err.message),
  });

  const send = useMutation({
    mutationFn: () => api.sendOutreachEmail({ leadId, to, subject, body, draftId: draft?.id, accountId: account?.id }),
    onSuccess: () => {
      toast.success(account?.canReceive
        ? `Sent to ${to} from ${account.email}. Replies are tracked automatically.`
        : `Sent to ${to} from ${account?.email}.`);
      queryClient.invalidateQueries({ queryKey: ["outreach-threads"] });
      queryClient.invalidateQueries({ queryKey: ["lead", leadId] });
    },
    onError: (err) => toast.error(err.message),
  });

  const sync = useMutation({
    mutationFn: api.syncOutreach,
    onSuccess: (data) => {
      toast.success(data?.sync?.replies ? `${data.sync.replies} new reply!` : "No new replies yet.");
      queryClient.invalidateQueries({ queryKey: ["outreach-threads"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const followUp = useMutation({
    mutationFn: (threadId) => api.sendFollowUpNow(threadId),
    onSuccess: () => {
      toast.success("Follow-up sent.");
      queryClient.invalidateQueries({ queryKey: ["outreach-threads"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const sendWa = useMutation({
    mutationFn: () => api.sendWhatsApp({ leadId, phone: waPhone, message: waMessage }),
    onSuccess: () => {
      toast.success("WhatsApp message sent. Replies land in this thread automatically.");
      queryClient.invalidateQueries({ queryKey: ["outreach-threads"] });
      queryClient.invalidateQueries({ queryKey: ["lead", leadId] });
    },
    onError: (err) => toast.error(err.message),
  });

  const copy = useCallback(() => {
    const text = channel === "WHATSAPP" ? waMessage : `Subject: ${subject}\n\n${body}`;
    navigator.clipboard.writeText(text)
      .then(() => toast.success(channel === "WHATSAPP" ? "Message copied" : "Email copied"), () => toast.error("Could not copy"));
  }, [subject, body, channel, waMessage]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sendDisabled = !to || !subject.trim() || !body.trim() || send.isPending;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[3px]" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-label="Outreach email" className="relative flex h-full w-full max-w-lg flex-col border-l border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--shadow-lg)]">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold">{name}</h2>
              <ThreadStatusChip thread={activeThread} />
            </div>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              {draft
                ? `${draft.generatedBy === "LLM" ? "AI-drafted" : "Template"} · grounded on ${draft.groundingFacts?.length ?? 0} verified facts`
                : "No draft yet — write one or hit Regenerate"}
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--surface-sunken)]" aria-label="Close"><X size={16} /></button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="flex rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-0.5">
            {[["EMAIL", Mail, "Email"], ["WHATSAPP", MessageCircle, "WhatsApp"]].map(([key, Icon, label]) => (
              <button
                key={key}
                onClick={() => setChannel(key)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                  channel === key
                    ? "bg-[var(--surface-raised)] text-[var(--text)] shadow-[var(--shadow-xs)]"
                    : "text-[var(--text-muted)] hover:text-[var(--text)]",
                )}
              >
                <Icon size={13} />{label}
                {key === "WHATSAPP" && waThread && <ThreadStatusChip thread={waThread} />}
                {key === "EMAIL" && emailThread && <ThreadStatusChip thread={emailThread} />}
              </button>
            ))}
          </div>

          {(contacts || address) && (
            <div className="flex flex-wrap gap-3 text-xs text-[var(--text-muted)]">
              {contacts?.email && <span className="inline-flex items-center gap-1"><Mail size={11} />{contacts.email.value}</span>}
              {contacts?.phone && <span className="inline-flex items-center gap-1"><Phone size={11} />{contacts.phone.value}</span>}
              {contacts?.whatsapp && <span className="inline-flex items-center gap-1"><MessageCircle size={11} />{contacts.whatsapp.value}</span>}
              {address && <span className="inline-flex items-center gap-1"><MapPin size={11} />{address.value}</span>}
            </div>
          )}

          {activeThread && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)]">
              <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                <p className="text-xs font-medium">
                  Conversation with {activeThread.recipientEmail}
                  {activeThread.followUpsSent > 0 && <span className="text-[var(--text-muted)]"> · {activeThread.followUpsSent} follow-up{activeThread.followUpsSent > 1 ? "s" : ""}</span>}
                </p>
                <div className="flex items-center gap-1.5">
                  {activeThread.channel !== "WHATSAPP" && followUpDue(activeThread) && (
                    <Button size="sm" variant="secondary" onClick={() => followUp.mutate(activeThread.id)} disabled={followUp.isPending}>
                      {followUp.isPending ? <Spinner size={12} /> : <Send size={11} />}Follow up now
                    </Button>
                  )}
                  {activeThread.channel !== "WHATSAPP" && (
                    <Button size="sm" variant="ghost" onClick={() => sync.mutate()} disabled={sync.isPending} title="Check for replies">
                      <RefreshCw size={12} className={sync.isPending ? "animate-spin" : undefined} />
                    </Button>
                  )}
                </div>
              </div>
              <ul className="max-h-56 space-y-2 overflow-y-auto border-t border-[var(--border)] px-3 py-2.5">
                {(activeThread.messages || []).map((m) => (
                  <li key={m.id} className={cn("rounded-lg border p-2.5 text-[12px]",
                    m.direction === "INBOUND"
                      ? "border-[color-mix(in_oklch,var(--color-positive)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-positive)_7%,transparent)]"
                      : "border-[var(--border)] bg-[var(--surface-raised)]")}>
                    <p className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-[var(--text-subtle)]">
                      <span>{m.direction === "INBOUND" ? `Reply from ${m.fromAddress || "them"}` : m.kind === "FOLLOW_UP" ? "Follow-up sent" : "Sent"}</span>
                      <span className="tnum normal-case">{formatDateTime(m.sentAt || m.receivedAt || m.createdAt)}</span>
                    </p>
                    <p className="line-clamp-4 whitespace-pre-wrap leading-snug text-[var(--text-muted)]">{m.body}</p>
                  </li>
                ))}
              </ul>
              {activeThread.status === "AWAITING_REPLY" && activeThread.nextFollowUpAt && !followUpDue(activeThread) && (
                <p className="border-t border-[var(--border)] px-3 py-2 text-[11px] text-[var(--text-subtle)]">
                  No reply yet — next follow-up {account?.autoFollowUp ? "goes out automatically" : "is due"} {formatDateTime(activeThread.nextFollowUpAt)}.
                </p>
              )}
              {activeThread.channel === "WHATSAPP" && activeThread.status === "AWAITING_REPLY" && (
                <p className="border-t border-[var(--border)] px-3 py-2 text-[11px] text-[var(--text-subtle)]">
                  Replies arrive here automatically while the app is running.
                </p>
              )}
            </div>
          )}

          {channel === "WHATSAPP" && (
            <div className="space-y-2.5">
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Phone (with country code)</label>
                <Input value={waPhone} onChange={(e) => setWaPhone(e.target.value)} placeholder="+966 5x xxx xxxx" />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Message</label>
                <Textarea value={waMessage} onChange={(e) => setWaMessage(e.target.value)} className="min-h-44 text-[13px] leading-relaxed" />
              </div>
              {!waConnected && (
                <p className="rounded-lg border border-[color-mix(in_oklch,var(--color-info)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-info)_8%,transparent)] p-3 text-xs leading-relaxed text-[var(--text-muted)]">
                  <Settings size={11} className="mr-1 inline" />
                  WhatsApp is not paired. Scan the QR code in{" "}
                  <Link to="/settings" className="text-[var(--accent)] hover:underline">Settings</Link> to send from here.
                  Until then, use Copy and send it from your phone.
                </p>
              )}
            </div>
          )}

          <div className={cn("space-y-2.5", channel !== "EMAIL" && "hidden")}>
            {activeThread && (
              <p className="text-[11px] text-[var(--text-muted)]">
                Already contacted — only send another initial email if you mean to start a separate thread.
              </p>
            )}
            {accounts.length > 0 && (
              <div>
                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">From</label>
                <Select className="w-full" value={account?.id || ""} onChange={(e) => setAccountId(e.target.value)}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id} disabled={a.status === "ERROR"}>
                      {a.displayName ? `${a.displayName} <${a.email}>` : a.email}
                      {a.isDefault ? " · default" : ""}
                      {a.status === "ERROR" ? " · needs attention" : ""}
                    </option>
                  ))}
                </Select>
                {account && !account.canReceive && (
                  <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
                    Send-only mailbox — replies to this address are not tracked in the app.
                  </p>
                )}
              </div>
            )}
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">To</label>
              <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="who@company.com" />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Subject</label>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Body</label>
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-52 font-[inherit] text-[13px] leading-relaxed" />
            </div>
          </div>

          {draft?.groundingFacts?.length > 0 && (
            <div>
              <button onClick={() => setShowFacts((v) => !v)} className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
                {showFacts ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                What this email is based on ({draft.groundingFacts.length} facts)
              </button>
              {showFacts && (
                <ol className="mt-2 space-y-1">
                  {draft.groundingFacts.map((f) => (
                    <li key={f.id} className={cn("text-[11px] leading-snug", (draft.factIdsUsed || []).includes(f.id) ? "text-[var(--text)]" : "text-[var(--text-subtle)]")}>
                      <span className="tnum">[{f.id}]</span> {f.text}
                      <Badge className="ml-1">{f.confidenceLevel}</Badge>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {!account && channel === "EMAIL" && (
            <p className="rounded-lg border border-[color-mix(in_oklch,var(--color-info)_35%,transparent)] bg-[color-mix(in_oklch,var(--color-info)_8%,transparent)] p-3 text-xs leading-relaxed text-[var(--text-muted)]">
              <Settings size={11} className="mr-1 inline" />
              Connect a mailbox in <Link to="/settings" className="text-[var(--accent)] hover:underline">Settings</Link> to
              send directly from here and track replies and follow-ups automatically. Until then, use Copy.
            </p>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-[var(--border)] px-5 py-3">
          {channel === "WHATSAPP" ? (
            waConnected ? (
              <Button onClick={() => sendWa.mutate()} disabled={!waPhone || !waMessage.trim() || sendWa.isPending}>
                {sendWa.isPending ? <Spinner size={13} /> : <Send size={13} />}Send WhatsApp
              </Button>
            ) : (
              <Button onClick={copy}><Copy size={13} />Copy message</Button>
            )
          ) : canSend ? (
            <Button onClick={() => send.mutate()} disabled={sendDisabled}>
              {send.isPending ? <Spinner size={13} /> : <Send size={13} />}Send
            </Button>
          ) : (
            <Button onClick={copy}><Copy size={13} />Copy email</Button>
          )}
          {(channel === "EMAIL" ? canSend : waConnected) && (
            <Button variant="secondary" onClick={copy}><Copy size={13} />Copy</Button>
          )}
          <Button variant="secondary" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
            {regenerate.isPending ? <Spinner size={13} /> : <RefreshCw size={13} />}Regenerate
          </Button>
          <Link to={`/leads/${leadId}`} className="ml-auto text-xs text-[var(--accent)] hover:underline">Full lead →</Link>
        </footer>
      </aside>
    </div>
  );
}
