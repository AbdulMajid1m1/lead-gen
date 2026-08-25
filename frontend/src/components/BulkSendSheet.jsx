import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { X, Mail, MessageCircle, Send, AlertTriangle, Clock } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { Button, Badge } from "./ui.jsx";
import { cn } from "../lib/format.js";

const PACE_OPTIONS = [
  { value: 60, label: "Careful — 1 per minute", hint: "Safest for new sender reputations." },
  { value: 45, label: "Standard — ~80 per hour", hint: "The default. Steady and unremarkable." },
  { value: 25, label: "Fast — ~2 per minute", hint: "Only for warmed-up senders." },
];

/**
 * The one confirmation between "leads selected" and "messages going out".
 *
 * Everything the user needs to not regret the click is on this sheet: which
 * channels, from which identities, how fast, how many will actually get
 * something, and the reassurance that unreachable leads are skipped rather
 * than errored. Sending is deliberately paced — that is stated, not hidden.
 */
export const BulkSendSheet = ({ open, onClose, selection, initialChannels = ["EMAIL"] }) => {
  const navigate = useNavigate();
  const [channels, setChannels] = useState(initialChannels);
  const [accountId, setAccountId] = useState("");
  const [waAccountId, setWaAccountId] = useState("");
  const [paceSeconds, setPaceSeconds] = useState(45);
  const [name, setName] = useState("");

  useEffect(() => { if (open) setChannels(initialChannels); }, [open, initialChannels]);

  const { data: emailAccounts } = useQuery({
    queryKey: ["email-accounts"], queryFn: api.listEmailAccounts, enabled: open, staleTime: 60_000,
  });
  const { data: waStatus } = useQuery({
    queryKey: ["wa-status"], queryFn: api.whatsappStatus, enabled: open, staleTime: 30_000,
  });

  const accounts = emailAccounts?.accounts || [];
  const devices = (waStatus?.accounts || []).filter((d) => d.connected || d.hasSession);
  const wantEmail = channels.includes("EMAIL");
  const wantWa = channels.includes("WHATSAPP");

  // Pre-select the defaults the moment the lists arrive.
  useEffect(() => { if (!accountId && accounts.length) setAccountId((accounts.find((a) => a.isDefault) || accounts[0]).id); }, [accounts, accountId]);
  useEffect(() => { if (!waAccountId && devices.length) setWaAccountId((devices.find((d) => d.isDefault) || devices[0]).id); }, [devices, waAccountId]);

  const toggleChannel = (ch) =>
    setChannels((prev) => (prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]));

  const create = useMutation({
    mutationFn: () => api.createCampaign({
      name: name.trim() || undefined,
      leadIds: selection.ids,
      channels,
      accountId: wantEmail && accountId ? accountId : undefined,
      waAccountId: wantWa && waAccountId ? waAccountId : undefined,
      paceSeconds,
    }),
    onSuccess: (data) => {
      toast.success("Campaign started — messages go out one by one from now.");
      onClose();
      navigate(`/outreach?campaign=${data.campaign.id}`);
    },
    onError: (err) => toast.error(err.message),
  });

  const blockers = useMemo(() => {
    const list = [];
    if (channels.length === 0) list.push("Pick at least one channel.");
    if (wantEmail && accounts.length === 0) list.push("No email account is connected — add one in Settings → Outreach.");
    if (wantWa && devices.length === 0) list.push("No WhatsApp device is linked — pair one in Settings → WhatsApp.");
    return list;
  }, [channels, wantEmail, wantWa, accounts.length, devices.length]);

  const estimateMinutes = Math.ceil((selection.ids.length * paceSeconds) / 60);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[3px]" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-label="Bulk send" className="relative flex h-full w-full max-w-md flex-col border-l border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--shadow-lg)]">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Send to {selection.ids.length} lead{selection.ids.length === 1 ? "" : "s"}</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              Messages go out one at a time with real spacing — bulk, without the blast.
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--surface-sunken)]" aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* Channels */}
          <section>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Channels</p>
            <div className="grid grid-cols-2 gap-2">
              {[["EMAIL", Mail, "Email"], ["WHATSAPP", MessageCircle, "WhatsApp"]].map(([ch, Icon, label]) => (
                <button
                  key={ch}
                  onClick={() => toggleChannel(ch)}
                  className={cn(
                    "flex items-center justify-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors",
                    channels.includes(ch)
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)] font-medium"
                      : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]",
                  )}
                >
                  <Icon size={15} />{label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-[var(--text-subtle)]">
              Selected: {selection.withEmail} lead(s) with an email · {selection.withPhone} with a phone number.
              Leads without an address for a channel are skipped automatically, never errored.
            </p>
          </section>

          {/* Senders */}
          {wantEmail && (
            <section>
              <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Send emails from</label>
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2.5 py-2 text-[13px] outline-none focus:border-[var(--accent)]"
              >
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.email}{a.isDefault ? " (default)" : ""}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
                Each lead gets its own drafted email; follow-ups continue automatically if there's no reply.
              </p>
            </section>
          )}
          {wantWa && (
            <section>
              <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Send WhatsApp from</label>
              <select
                value={waAccountId}
                onChange={(e) => setWaAccountId(e.target.value)}
                className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2.5 py-2 text-[13px] outline-none focus:border-[var(--accent)]"
              >
                {devices.map((d) => <option key={d.id} value={d.id}>{d.label || d.user || d.id}{d.isDefault ? " (default)" : ""}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
                A short chat-shaped first message — one observation, one question. No links, no wall of text.
              </p>
            </section>
          )}

          {/* Pace */}
          <section>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Sending pace</p>
            <div className="space-y-1.5">
              {PACE_OPTIONS.map((o) => (
                <label key={o.value} className={cn(
                  "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors",
                  paceSeconds === o.value ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border)] hover:border-[var(--border-strong)]",
                )}>
                  <input type="radio" name="pace" checked={paceSeconds === o.value} onChange={() => setPaceSeconds(o.value)} className="mt-1 accent-[var(--accent)]" />
                  <span>
                    <span className="block text-[13px] font-medium">{o.label}</span>
                    <span className="block text-[11px] text-[var(--text-subtle)]">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-[var(--text-subtle)]">
              <Clock size={10} />Roughly {estimateMinutes} min to drain {selection.ids.length} leads at this pace, within daily caps.
            </p>
          </section>

          {/* Name */}
          <section>
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Campaign name <span className="normal-case">(optional)</span></label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`Bulk send · ${new Date().toLocaleDateString("en-GB")}`}
              maxLength={160}
              className="w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-2 text-[13px] outline-none placeholder:text-[var(--text-subtle)] focus:border-[var(--accent)]"
            />
            <p className="mt-1 text-[11px] text-[var(--text-subtle)]">How this batch appears on the Outreach page.</p>
          </section>

          {blockers.length > 0 && (
            <div className="rounded-lg border border-[color-mix(in_oklch,var(--color-caution)_40%,transparent)] bg-[color-mix(in_oklch,var(--color-caution)_8%,transparent)] p-3">
              {blockers.map((b, i) => (
                <p key={i} className="flex items-start gap-2 text-[12px] text-[var(--text-muted)]">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--color-caution)]" />{b}
                </p>
              ))}
            </div>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-[var(--border)] px-5 py-3">
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || blockers.length > 0 || selection.ids.length === 0}
          >
            <Send size={13} />{create.isPending ? "Starting…" : `Start sending to ${selection.ids.length}`}
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Badge className="ml-auto">{channels.map((c) => (c === "EMAIL" ? "Email" : "WhatsApp")).join(" + ") || "no channel"}</Badge>
        </footer>
      </aside>
    </div>
  );
};
