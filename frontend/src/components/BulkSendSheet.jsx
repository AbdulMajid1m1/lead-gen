import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { X, Mail, MessageCircle, Send, AlertTriangle, Clock, CalendarClock, ShieldCheck, Flame, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { Button, Badge, FormField, Input } from "./ui.jsx";
import { cn } from "../lib/format.js";
import {
  SEND_DAY_PRESETS, daysForPreset, describeDays, hourLabel,
  toDateTimeLocal, fromDateTimeLocal, nextSendMorning, nextWeekday,
  estimateAutoSchedule, formatMoment,
} from "../lib/schedule.js";

const PACE_OPTIONS = [
  { value: 60, label: "Careful — 1 per minute", hint: "Safest for new sender reputations." },
  { value: 45, label: "Standard — ~80 per hour", hint: "The default. Steady and unremarkable." },
  { value: 25, label: "Fast — ~2 per minute", hint: "Only for warmed-up senders." },
];

/** The everyday volumes. The planner may add a fourth, sized to the sender. */
const VOLUME_PRESETS = [
  { value: 20, label: "20 a day", hint: "Gentle. Right for a new mailbox or number." },
  { value: 40, label: "40 a day", hint: "Steady. The everyday volume for an established sender." },
  { value: 80, label: "80 a day", hint: "Brisk. Only for a sender with a long, clean history." },
];

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: hourLabel(h) }));
const DAY_MS = 86_400_000;
const MAX_AHEAD_DAYS_FALLBACK = 90;

const sectionLabel = "mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]";
const selectCls = "w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2.5 py-2 text-[13px] outline-none focus:border-[var(--accent)]";

/**
 * A radio-styled option card. Shared by every choice list on the sheet.
 * Deliberately holds no other controls: a label may contain only the one
 * element it labels, so anything an option needs (a date, a number) is
 * rendered as a sibling panel beneath it.
 */
const OptionCard = ({ name, checked, onChange, label, hint, badge, disabled }) => (
  <label className={cn(
    "flex items-start gap-2.5 rounded-lg border px-3 py-2 transition-colors",
    disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
    checked ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border)] hover:border-[var(--border-strong)]",
  )}>
    <input type="radio" name={name} checked={checked} onChange={onChange} disabled={disabled} className="mt-1 accent-[var(--accent)]" />
    <span className="min-w-0 flex-1">
      <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
        {label}
        {badge && <Badge tone="var(--color-positive)">{badge}</Badge>}
      </span>
      {hint && <span className="block text-[11px] text-[var(--text-subtle)]">{hint}</span>}
    </span>
  </label>
);

/** The detail panel that belongs to a selected option, indented to sit under it. */
const OptionPanel = ({ children }) => (
  <div className="ml-6 rounded-lg border border-dashed border-[var(--border)] px-3 py-2.5">{children}</div>
);

/**
 * One sender's day, in the numbers the drain will actually enforce: cap,
 * spent, claimed by other campaigns, warm-up stage. Shown under the sender
 * picker so the daily volume chosen below is chosen with eyes open.
 */
const SenderBudget = ({ budget, noun }) => {
  if (!budget) return null;
  const used = Math.min(budget.hardCap, budget.sentToday + budget.committed);
  const pct = budget.hardCap ? Math.min(100, (used / budget.hardCap) * 100) : 0;
  return (
    <div className="mt-2 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1"><ShieldCheck size={11} />Today's budget for this {noun}</span>
        <span className="tnum">{budget.sentToday} sent · {budget.committed} claimed · cap {budget.hardCap}</span>
      </div>
      <div className="mt-1.5 flex h-1 overflow-hidden rounded-full bg-[var(--surface-raised)]">
        <div style={{ width: `${Math.min(100, (budget.sentToday / Math.max(1, budget.hardCap)) * 100)}%`, background: "var(--accent)" }} />
        <div style={{ width: `${Math.max(0, pct - (budget.sentToday / Math.max(1, budget.hardCap)) * 100)}%`, background: "var(--color-ink-400)" }} />
      </div>
      <ul className="mt-1.5 space-y-0.5 text-[11px] text-[var(--text-subtle)]">
        {budget.warmup && (
          <li className="inline-flex items-center gap-1">
            <Flame size={10} className="text-[var(--color-caution)]" />
            Warm-up day {budget.warmup.day} of 21 — capped at {budget.warmup.cap} a day until it has a track record.
          </li>
        )}
        {budget.activeCampaigns > 0 && (
          <li>{budget.activeCampaigns} other campaign{budget.activeCampaigns === 1 ? "" : "s"} already claim{budget.activeCampaigns === 1 ? "s" : ""} {budget.committed} a day here.</li>
        )}
        {budget.fullyBooked
          ? <li className="text-[var(--color-caution)]">Fully booked — a new campaign would queue behind the others each day.</li>
          : <li>Room for about {budget.headroom} more a day. Recommended: {budget.recommended} a day.</li>}
      </ul>
    </div>
  );
};

/**
 * The one confirmation between "leads selected" and "messages going out".
 *
 * Everything the user needs to not regret the click is on this sheet: which
 * channels, from which identities, when it starts, how much per day, how many
 * will actually get something, and the reassurance that unreachable leads are
 * skipped rather than errored. Sending is deliberately paced — that is stated,
 * not hidden — and the daily volume is proposed from what the sender can
 * take on today rather than left as a guess.
 */
export const BulkSendSheet = ({ open, onClose, selection, initialChannels = ["EMAIL"] }) => {
  const navigate = useNavigate();
  const [channels, setChannels] = useState(initialChannels);
  const [accountId, setAccountId] = useState("");
  const [waAccountId, setWaAccountId] = useState("");
  const [paceSeconds, setPaceSeconds] = useState(45);
  // AUTO is the default: schedule-shaped sending is the deliverability-safe
  // path; "send now" is the explicit opt-out.
  const [mode, setMode] = useState("AUTO");
  // `volumeChoice` is a preset value or "custom"; the planner may move it once,
  // before the user has touched it.
  const [volumeChoice, setVolumeChoice] = useState(40);
  const [customLimit, setCustomLimit] = useState("30");
  const volumeTouched = useRef(false);
  const [dayPreset, setDayPreset] = useState("weekdays");
  const [windowStart, setWindowStart] = useState(9);
  const [windowEnd, setWindowEnd] = useState(18);
  const [startMode, setStartMode] = useState("now"); // "now" | "later"
  const [startAtInput, setStartAtInput] = useState("");
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

  // What the chosen senders can take on today. Re-fetched when the sender
  // changes, because the answer is per mailbox.
  const { data: plan } = useQuery({
    queryKey: ["campaign-planner", wantEmail ? accountId || null : null, wantWa ? waAccountId || null : null],
    queryFn: () => api.campaignPlanner({ accountId: wantEmail ? accountId : undefined, waAccountId: wantWa ? waAccountId : undefined }),
    enabled: open,
    staleTime: 30_000,
  });

  // The tighter of the selected channels' budgets governs the daily volume:
  // a campaign on both channels reaches each lead once, so it is one number.
  const budgets = useMemo(
    () => [wantEmail ? plan?.email : null, wantWa ? plan?.whatsapp : null].filter(Boolean),
    [plan, wantEmail, wantWa],
  );
  const hardCap = budgets.length ? Math.min(...budgets.map((b) => b.hardCap)) : null;
  const recommended = budgets.length ? Math.min(...budgets.map((b) => b.recommended)) : null;
  const minDaily = plan?.minDailyLimit ?? 5;
  const maxAheadDays = plan?.maxScheduleAheadDays ?? MAX_AHEAD_DAYS_FALLBACK;

  // Propose the recommended volume once, then leave the choice alone.
  useEffect(() => {
    if (recommended && !volumeTouched.current) setVolumeChoice(recommended);
  }, [recommended]);

  const volumeOptions = useMemo(() => {
    const list = recommended && !VOLUME_PRESETS.some((o) => o.value === recommended)
      ? [{ value: recommended, label: `${recommended} a day`, hint: "Sized to what this sender can take on today." }, ...VOLUME_PRESETS]
      : VOLUME_PRESETS;
    return list.map((o) => ({
      ...o,
      recommended: o.value === recommended,
      // A preset above today's cap would only stall the campaign each day.
      disabled: hardCap !== null && o.value > hardCap,
      hint: hardCap !== null && o.value > hardCap ? `Above this sender's cap of ${hardCap} a day today.` : o.hint,
    }));
  }, [recommended, hardCap]);

  const customValue = Number(customLimit);
  const customMax = Math.min(150, hardCap ?? 150);
  const customError = volumeChoice !== "custom" ? null
    : !Number.isInteger(customValue) ? "Enter a whole number."
    : customValue < minDaily ? `At least ${minDaily} a day.`
    : customValue > customMax ? `At most ${customMax} a day for this sender.`
    : null;
  const dailyLimit = volumeChoice === "custom" ? (customError ? null : customValue) : volumeChoice;

  const sendDays = daysForPreset(dayPreset);
  const toggleChannel = (ch) =>
    setChannels((prev) => (prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]));

  // ── When to start ──────────────────────────────────────────────────────────
  const startAt = startMode === "later" ? fromDateTimeLocal(startAtInput) : null;
  const startError = startMode !== "later" ? null
    : !startAtInput ? "Pick a date and time."
    : !startAt ? "That date could not be read."
    : startAt.getTime() < Date.now() + 60_000 ? "That time has already passed — pick a moment in the future, or start now."
    : startAt.getTime() > Date.now() + maxAheadDays * DAY_MS ? `At most ${maxAheadDays} days ahead.`
    : null;
  const nowMin = toDateTimeLocal(new Date(Date.now() + 5 * 60_000));
  const startShortcuts = [
    { label: "Tomorrow morning", at: () => nextSendMorning({ hour: windowStart, days: sendDays }) },
    { label: "Next Monday", at: () => nextWeekday(1, { hour: windowStart }) },
  ];

  // ── What will happen ───────────────────────────────────────────────────────
  const windowValid = windowEnd > windowStart;
  const estimate = useMemo(() => (mode === "AUTO" && dailyLimit && windowValid && !startError
    ? estimateAutoSchedule({ count: selection.ids.length, dailyLimit, sendDays, windowStart, windowEnd, startAt: startAt || new Date() })
    : null), [mode, dailyLimit, windowValid, startError, selection.ids.length, sendDays, windowStart, windowEnd, startAt]);
  const estimateMinutes = Math.ceil((selection.ids.length * paceSeconds) / 60);

  const create = useMutation({
    mutationFn: () => api.createCampaign({
      name: name.trim() || undefined,
      leadIds: selection.ids,
      channels,
      accountId: wantEmail && accountId ? accountId : undefined,
      waAccountId: wantWa && waAccountId ? waAccountId : undefined,
      paceSeconds,
      mode,
      ...(mode === "AUTO" ? { dailyLimit, windowStart, windowEnd, sendDays } : {}),
      ...(startAt ? { startAt: startAt.toISOString() } : {}),
      // Minutes east of UTC, so the server can interpret the window in the
      // user's local clock (JS offset is west-positive, hence the negation).
      tzOffsetMinutes: -new Date().getTimezoneOffset(),
    }),
    onSuccess: (data) => {
      const scheduled = data.campaign.status === "SCHEDULED";
      toast.success(scheduled
        ? `Scheduled — first message ${estimate ? formatMoment(estimate.firstSendAt) : formatMoment(startAt)}.`
        : mode === "AUTO"
          ? "Campaign started — sends spread across your daily window from now."
          : "Campaign started — messages go out one by one from now.");
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
    if (mode === "AUTO" && !windowValid) list.push("The sending window must end after it starts.");
    if (mode === "AUTO" && customError) list.push(`Daily volume: ${customError}`);
    // A preset chosen before switching to a smaller mailbox can be above its
    // cap; the server would accept it and the campaign would stall each day.
    if (mode === "AUTO" && hardCap !== null && dailyLimit > hardCap) list.push(`Daily volume is above this sender's cap of ${hardCap} today — pick a lower volume.`);
    if (startError) list.push(`Start time: ${startError}`);
    return list;
  }, [channels, wantEmail, wantWa, accounts.length, devices.length, mode, windowValid, customError, startError, hardCap, dailyLimit]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const count = selection.ids.length;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[3px]" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-label="Bulk send" className="relative flex h-full w-full max-w-lg flex-col border-l border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--shadow-lg)]">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Send to {count} lead{count === 1 ? "" : "s"}</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              Messages go out one at a time with real spacing, never more than the daily cap — bulk, without the blast.
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--surface-sunken)]" aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* 1 · Channels */}
          <section>
            <p className={sectionLabel}>1 · Channels</p>
            <div className="grid grid-cols-2 gap-2">
              {[["EMAIL", Mail, "Email"], ["WHATSAPP", MessageCircle, "WhatsApp"]].map(([ch, Icon, label]) => (
                <button
                  key={ch}
                  type="button"
                  onClick={() => toggleChannel(ch)}
                  aria-pressed={channels.includes(ch)}
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
              Selected: {selection.withEmail} lead(s) with an email · {selection.withWhatsApp ?? selection.withPhone} reachable on WhatsApp.
              Leads without an address for a channel are skipped automatically, never errored.
            </p>
          </section>

          {/* 2 · Senders */}
          {(wantEmail || wantWa) && (
            <section className="space-y-3">
              <p className={sectionLabel}>2 · Send from</p>
              {wantEmail && (
                <div>
                  <label htmlFor="bulk-email-account" className="mb-1 block text-[12px] text-[var(--text-muted)]">Email account</label>
                  <select id="bulk-email-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.email}{a.isDefault ? " (default)" : ""}</option>)}
                  </select>
                  <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
                    Each lead gets its own drafted email; follow-ups continue automatically if there's no reply.
                  </p>
                  <SenderBudget budget={plan?.email} noun="mailbox" />
                </div>
              )}
              {wantWa && (
                <div>
                  <label htmlFor="bulk-wa-account" className="mb-1 block text-[12px] text-[var(--text-muted)]">WhatsApp device</label>
                  <select id="bulk-wa-account" value={waAccountId} onChange={(e) => setWaAccountId(e.target.value)} className={selectCls}>
                    {devices.map((d) => <option key={d.id} value={d.id}>{d.label || d.user || d.id}{d.isDefault ? " (default)" : ""}</option>)}
                  </select>
                  <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
                    A short chat-shaped first message — one observation, one question. No links, no wall of text.
                  </p>
                  <SenderBudget budget={plan?.whatsapp} noun="number" />
                </div>
              )}
            </section>
          )}

          {/* 3 · When to start */}
          <section>
            <p className={sectionLabel}>3 · When to start</p>
            <div className="space-y-1.5">
              <OptionCard name="start" checked={startMode === "now"} onChange={() => setStartMode("now")}
                label="Start now" hint="The first message leaves on the next tick, inside the sending window below." />
              <OptionCard name="start" checked={startMode === "later"} onChange={() => setStartMode("later")}
                label="Schedule for later" hint="Pick a date and time. Nothing is sent before it." />
              {startMode === "later" && (
                <OptionPanel>
                  <FormField label="Start date and time" hint="(your local time)" error={startError && startAtInput ? startError : undefined}
                    help={`Up to ${maxAheadDays} days ahead. If it falls outside the sending days or hours, the first message waits for the next slot.`}>
                    {(field) => (
                      <Input {...field} type="datetime-local" value={startAtInput} min={nowMin}
                        onChange={(e) => setStartAtInput(e.target.value)} className="text-[13px]" />
                    )}
                  </FormField>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {startShortcuts.map((s) => (
                      <button key={s.label} type="button" onClick={() => setStartAtInput(toDateTimeLocal(s.at()))}
                        className="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]">
                        {s.label}
                      </button>
                    ))}
                  </div>
                </OptionPanel>
              )}
            </div>
          </section>

          {/* 4 · How to send */}
          <section>
            <p className={sectionLabel}>4 · How to send</p>
            <div className="space-y-1.5">
              <OptionCard name="mode" checked={mode === "AUTO"} onChange={() => setMode("AUTO")} badge="Recommended"
                label="Spread over days" hint="A limited number each day, only on sending days and inside working hours. Protects your bounce rate and sender reputation." />
              <OptionCard name="mode" checked={mode === "DIRECT"} onChange={() => setMode("DIRECT")}
                label="Drain at a fixed pace" hint="One after another at a set gap, around the clock, until the daily cap stops it for the day." />
            </div>
          </section>

          {mode === "AUTO" ? (
            <>
              <section>
                <p className={sectionLabel}>Daily volume</p>
                <div className="space-y-1.5">
                  {volumeOptions.map((o) => (
                    <OptionCard key={o.value} name="dailyLimit" checked={volumeChoice === o.value} disabled={o.disabled}
                      onChange={() => { volumeTouched.current = true; setVolumeChoice(o.value); }}
                      label={o.label} hint={o.hint} badge={o.recommended ? "Recommended" : undefined} />
                  ))}
                  <OptionCard name="dailyLimit" checked={volumeChoice === "custom"}
                    onChange={() => { volumeTouched.current = true; setVolumeChoice("custom"); }}
                    label="Custom" hint={`Between ${minDaily} and ${customMax} a day.`} />
                  {volumeChoice === "custom" && (
                    <OptionPanel>
                      <FormField label="Messages per day" error={customError} className="max-w-40">
                        {(field) => (
                          <Input {...field} type="number" inputMode="numeric" min={minDaily} max={customMax} step={1}
                            value={customLimit} onChange={(e) => setCustomLimit(e.target.value)} placeholder="30" className="text-[13px]" />
                        )}
                      </FormField>
                    </OptionPanel>
                  )}
                </div>
                <p className="mt-1.5 text-[11px] text-[var(--text-subtle)]">
                  This is the campaign's own limit. The sender's daily cap{hardCap !== null ? ` (${hardCap} today)` : ""} still applies across every campaign, so the total can never exceed it.
                </p>
              </section>

              <section>
                <p className={sectionLabel}>Sending days</p>
                <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Sending days">
                  {SEND_DAY_PRESETS.map((p) => (
                    <button key={p.key} type="button" role="radio" aria-checked={dayPreset === p.key} title={p.hint}
                      onClick={() => setDayPreset(p.key)}
                      className={cn(
                        "rounded-lg border px-2 py-2 text-[13px] transition-colors",
                        dayPreset === p.key
                          ? "border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--accent)]"
                          : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]",
                      )}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-[var(--text-subtle)]">
                  {SEND_DAY_PRESETS.find((p) => p.key === dayPreset)?.hint}
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Between</span>
                  <select value={windowStart} onChange={(e) => setWindowStart(Number(e.target.value))} aria-label="Window start"
                    className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent)]">
                    {HOURS.slice(0, 23).map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
                  </select>
                  <span className="text-[11px] text-[var(--text-subtle)]">and</span>
                  <select value={windowEnd} onChange={(e) => setWindowEnd(Number(e.target.value))} aria-label="Window end"
                    className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 py-1.5 text-[13px] outline-none focus:border-[var(--accent)]">
                    {HOURS.slice(1).map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
                  </select>
                  <span className="text-[11px] text-[var(--text-subtle)]">your time</span>
                </div>
                {!windowValid && <p role="alert" className="mt-1 text-[11px] text-[var(--color-critical)]">The window must end after it starts.</p>}
              </section>
            </>
          ) : (
            <section>
              <p className={sectionLabel}>Sending pace</p>
              <div className="space-y-1.5">
                {PACE_OPTIONS.map((o) => (
                  <OptionCard key={o.value} name="pace" checked={paceSeconds === o.value} onChange={() => setPaceSeconds(o.value)} label={o.label} hint={o.hint} />
                ))}
              </div>
            </section>
          )}

          {/* What will happen — the whole plan in one place, in plain words. */}
          <section className="rounded-lg border border-[color-mix(in_oklch,var(--accent)_35%,transparent)] bg-[color-mix(in_oklch,var(--accent)_6%,transparent)] p-3">
            <p className="mb-1.5 inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--accent)]">
              <CalendarClock size={12} />What will happen
            </p>
            <ul className="space-y-1 text-[12px] leading-snug text-[var(--text-muted)]">
              {mode === "AUTO" ? (
                estimate ? (
                  <>
                    <li><CheckCircle2 size={11} className="mr-1 inline text-[var(--color-positive)]" />First message <strong className="text-[var(--text)]">{formatMoment(estimate.firstSendAt)}</strong>.</li>
                    <li><CheckCircle2 size={11} className="mr-1 inline text-[var(--color-positive)]" />Up to <strong className="text-[var(--text)]">{dailyLimit} a day</strong>, {describeDays(sendDays)}, {hourLabel(windowStart)}–{hourLabel(windowEnd)}, spaced out with a little randomness so it never looks automated.</li>
                    <li><CheckCircle2 size={11} className="mr-1 inline text-[var(--color-positive)]" />All {count} reached by about <strong className="text-[var(--text)]">{formatMoment(estimate.lastSendAt)}</strong> — {estimate.sendingDays} sending day{estimate.sendingDays === 1 ? "" : "s"}{estimate.calendarDays !== estimate.sendingDays ? ` over ${estimate.calendarDays} calendar days` : ""}.</li>
                  </>
                ) : (
                  <li className="inline-flex items-center gap-1"><Clock size={11} />Fix the highlighted fields to see the plan.</li>
                )
              ) : (
                <>
                  <li><CheckCircle2 size={11} className="mr-1 inline text-[var(--color-positive)]" />Starts <strong className="text-[var(--text)]">{startAt && !startError ? formatMoment(startAt) : "now"}</strong>, one message every {paceSeconds} seconds.</li>
                  <li><CheckCircle2 size={11} className="mr-1 inline text-[var(--color-positive)]" />Roughly {estimateMinutes} min for {count} leads; stops for the day at the sender's cap{hardCap !== null ? ` of ${hardCap}` : ""} and resumes tomorrow.</li>
                </>
              )}
              <li><ShieldCheck size={11} className="mr-1 inline text-[var(--text-subtle)]" />Leads with no address, an existing conversation, or a country where cold outreach is unlawful are skipped and listed — never errored. You can pause or cancel at any time from the Outreach page.</li>
            </ul>
          </section>

          {/* Name */}
          <section>
            <FormField label="Campaign name" hint="(optional)" help="How this batch appears on the Outreach page.">
              {(field) => (
                <Input {...field} value={name} onChange={(e) => setName(e.target.value)} maxLength={160}
                  placeholder={`Bulk send · ${new Date().toLocaleDateString("en-GB")}`} className="text-[13px]" />
              )}
            </FormField>
          </section>

          {blockers.length > 0 && (
            <div role="alert" className="rounded-lg border border-[color-mix(in_oklch,var(--color-caution)_40%,transparent)] bg-[color-mix(in_oklch,var(--color-caution)_8%,transparent)] p-3">
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
            disabled={create.isPending || blockers.length > 0 || count === 0}
          >
            {startMode === "later" ? <CalendarClock size={13} /> : <Send size={13} />}
            {create.isPending ? (startMode === "later" ? "Scheduling…" : "Starting…")
              : startMode === "later" ? `Schedule ${count} lead${count === 1 ? "" : "s"}` : `Start sending to ${count}`}
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Badge className="ml-auto">{channels.map((c) => (c === "EMAIL" ? "Email" : "WhatsApp")).join(" + ") || "no channel"}</Badge>
        </footer>
      </aside>
    </div>
  );
};
