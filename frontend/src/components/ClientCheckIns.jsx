import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus, Send, Mail, MessageCircle, Phone, Globe, Link2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { Badge, Button, FormField, Input, SectionHeading, Select, Spinner, Surface, Textarea } from "./ui.jsx";
import { CHANNEL_LABELS, formatDate, relativeTime, toDateInput } from "../lib/format.js";

/**
 * The check-in log.
 *
 * Deliberately append-only from here: logging a conversation is the only thing
 * that moves "last contacted", so the quiet-client list can never be quietly
 * gamed by editing a date. Booking the next check-in is folded into the same
 * form, because deciding when to call back is part of finishing a call — not a
 * separate chore anyone would come back to do.
 */

const CHANNEL_ICONS = {
  EMAIL: Mail,
  WHATSAPP: MessageCircle,
  PHONE: Phone,
  CONTACT_FORM: Link2,
  SOCIAL: Globe,
};

/** Ready-made next-check-in dates, so the common case is one click. */
const IN_DAYS = [
  { days: 30, label: "In a month" },
  { days: 90, label: "In 3 months" },
  { days: 180, label: "In 6 months" },
];

const addDays = (days) => toDateInput(Date.now() + days * 86_400_000);

/**
 * A booked follow-up still in the future is carried into the form, so leaving
 * the field alone preserves it and emptying it is a deliberate act. One that has
 * already come due is left blank instead: that reminder is what prompted this
 * very check-in, and the useful next question is when to call again.
 */
const emptyForm = (client) => {
  const booked = client?.nextFollowUpAt;
  const stillAhead = booked && new Date(booked).getTime() > Date.now();
  return {
    channel: "EMAIL",
    summary: "",
    occurredAt: toDateInput(Date.now()),
    nextFollowUpAt: stillAhead ? toDateInput(booked) : "",
  };
};

export const ClientCheckIns = ({ client }) => {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => emptyForm(client));
  const [touched, setTouched] = useState(false);
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  const today = toDateInput(Date.now());
  const summaryError = !form.summary.trim() ? "Write a line about what was discussed — future you will need it." : undefined;
  const dateError = form.occurredAt > today ? "A check-in cannot be in the future. Use “Next check-in” for that." : undefined;
  const hasErrors = Boolean(summaryError || dateError);

  const log = useMutation({
    mutationFn: () => api.logClientTouchpoint(client.id, {
      channel: form.channel,
      summary: form.summary.trim(),
      occurredAt: form.occurredAt,
      nextFollowUpAt: form.nextFollowUpAt,
    }),
    onSuccess: (data) => {
      toast.success(data?.message || "Check-in logged.");
      setForm(emptyForm(data?.client));
      setTouched(false);
      queryClient.invalidateQueries({ queryKey: ["client", client.id] });
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["client-facets"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (hasErrors) return;
    log.mutate();
  };

  return (
    <Surface className="p-5">
      <SectionHeading
        icon={MessageSquarePlus}
        title="Check-ins"
        description="Log every conversation as it happens. It is what keeps this client off — or on — the “needs a check-in” list."
      />

      <form onSubmit={submit} className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-3.5">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="How" help="Where the conversation actually happened.">
            {(a) => (
              <Select {...a} value={form.channel} onChange={(e) => set("channel")(e.target.value)}>
                {Object.entries(CHANNEL_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </Select>
            )}
          </FormField>

          <FormField label="When" error={touched ? dateError : undefined} help="Backdate it if you are catching up on notes.">
            {(a) => <Input {...a} type="date" max={today} value={form.occurredAt} onChange={(e) => set("occurredAt")(e.target.value)} />}
          </FormField>
        </div>

        <FormField label="What was said" required error={touched ? summaryError : undefined}>
          {(a) => (
            <Textarea {...a} rows={3} maxLength={2000} value={form.summary} onChange={(e) => set("summary")(e.target.value)}
              placeholder="Called Sara — portal is fine, but they want a mobile app for drivers next quarter. Send a scope by the 15th." />
          )}
        </FormField>

        <FormField label="Next check-in" hint="optional" help="Leave empty and the book nudges you again after 90 quiet days.">
          {(a) => (
            <div className="space-y-2">
              <Input {...a} type="date" min={today} value={form.nextFollowUpAt} onChange={(e) => set("nextFollowUpAt")(e.target.value)} />
              <div className="flex flex-wrap gap-1.5">
                {IN_DAYS.map(({ days, label }) => (
                  <button
                    key={days}
                    type="button"
                    onClick={() => set("nextFollowUpAt")(addDays(days))}
                    className="rounded-md border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  >
                    {label}
                  </button>
                ))}
                {form.nextFollowUpAt && (
                  <button
                    type="button"
                    onClick={() => set("nextFollowUpAt")("")}
                    className="rounded-md px-2 py-0.5 text-[11px] text-[var(--text-subtle)] hover:text-[var(--text)]"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}
        </FormField>

        <Button type="submit" disabled={log.isPending || (touched && hasErrors)}>
          {log.isPending ? <Spinner size={13} /> : <Send size={13} />}Log check-in
        </Button>
      </form>

      {client.touchpoints.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-[var(--border-strong)] p-4 text-center text-xs text-[var(--text-muted)]">
          Nothing logged yet. The first entry is what starts the clock on this client.
        </p>
      ) : (
        <ol className="mt-4 space-y-3">
          {client.touchpoints.map((t) => {
            const Icon = CHANNEL_ICONS[t.channel] || Mail;
            return (
              <li key={t.id} className="flex gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-sunken)]">
                  <Icon size={12} className="text-[var(--text-subtle)]" />
                </span>
                <div className="min-w-0 flex-1 border-b border-[var(--border)] pb-3 last:border-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{CHANNEL_LABELS[t.channel]}</Badge>
                    <span className="text-[11px] text-[var(--text-subtle)]" title={formatDate(t.occurredAt)}>
                      {relativeTime(t.occurredAt)}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed">{t.summary}</p>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {client.touchpoints.length >= 50 && (
        <p className="mt-3 text-[11px] text-[var(--text-subtle)]">Showing the 50 most recent check-ins.</p>
      )}
    </Surface>
  );
};
