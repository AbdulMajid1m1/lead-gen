import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Mail, Plus, RefreshCw, CheckCircle2, AlertCircle, Star, Pencil, Trash2, Send, Inbox,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { Badge, Button, Input, Select, Skeleton, Spinner, Surface, SectionHeading, Textarea } from "./ui.jsx";
import { formatDateTime } from "../lib/format.js";

/**
 * Every mailbox outreach can be sent from. Several may be connected at once;
 * the composer picks one per email and the starred one is pre-selected.
 *
 * Sending and receiving are separate connections: a mailbox may send through
 * one host (Gmail, Resend, any SMTP relay) while its replies are read from a
 * different inbox — which is what makes "send as a domain address, receive in
 * Gmail" work. Leave the inbox blank and the mailbox is send-only.
 */

const PROVIDERS = {
  GMAIL: {
    label: "Gmail / Google Workspace",
    hint: "App password from https://myaccount.google.com/apppasswords (needs 2-step verification).",
    defaults: {
      smtpHost: "smtp.gmail.com", smtpPort: 465, smtpUser: "",
      imapHost: "imap.gmail.com", imapPort: 993, imapUser: "",
    },
    secretLabel: "App password",
    secretPlaceholder: "xxxx xxxx xxxx xxxx",
  },
  RESEND: {
    label: "Resend (domain sender)",
    hint: "Verify your domain in Resend first, then paste an API key. Resend only sends — set an inbox below to track replies.",
    defaults: {
      smtpHost: "smtp.resend.com", smtpPort: 465, smtpUser: "resend",
      imapHost: "", imapPort: 993, imapUser: "",
    },
    secretLabel: "Resend API key",
    secretPlaceholder: "re_xxxxxxxxxxxxxxxx",
  },
  SMTP: {
    label: "Custom SMTP",
    hint: "Any SMTP host — Zoho, Fastmail, Mailgun, your own relay.",
    defaults: {
      smtpHost: "", smtpPort: 465, smtpUser: "",
      imapHost: "", imapPort: 993, imapUser: "",
    },
    secretLabel: "SMTP password",
    secretPlaceholder: "••••••••",
  },
};

const emptyForm = (provider = "GMAIL") => ({
  provider,
  email: "",
  appPassword: "",
  displayName: "",
  replyTo: "",
  signature: "",
  autoFollowUp: true,
  maxFollowUps: 2,
  imapPassword: "",
  ...PROVIDERS[provider].defaults,
});

const formFrom = (account) => ({
  provider: account.provider in PROVIDERS ? account.provider : "SMTP",
  email: account.email,
  appPassword: "",
  displayName: account.displayName || "",
  replyTo: account.replyTo || "",
  signature: account.signature || "",
  autoFollowUp: account.autoFollowUp,
  maxFollowUps: account.maxFollowUps,
  smtpHost: account.smtpHost || "",
  smtpPort: account.smtpPort || 465,
  smtpUser: account.smtpUser || "",
  imapHost: account.imapHost || "",
  imapPort: account.imapPort || 993,
  imapUser: account.imapUser || "",
  imapPassword: "",
});

const Labelled = ({ label, hint, children }) => (
  <label className="block">
    <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
      {label}
      {hint && <span className="ml-1 normal-case text-[var(--text-subtle)]">{hint}</span>}
    </span>
    <div className="mt-1">{children}</div>
  </label>
);

/** The add/edit form. `account` null means a new connection. */
const AccountEditor = ({ account, onDone }) => {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => (account ? formFrom(account) : emptyForm()));
  const preset = PROVIDERS[form.provider];
  const isNew = !account;

  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  const switchProvider = (provider) => {
    // Reset only the transport fields — identity and preferences carry over.
    setForm((f) => ({ ...f, provider, ...PROVIDERS[provider].defaults }));
  };

  const payload = () => ({
    provider: form.provider,
    email: form.email.trim(),
    ...(form.appPassword ? { appPassword: form.appPassword } : {}),
    displayName: form.displayName.trim() || undefined,
    replyTo: form.replyTo.trim(),
    smtpHost: form.smtpHost.trim(),
    smtpPort: Number(form.smtpPort) || 465,
    smtpUser: form.smtpUser.trim(),
    // An empty host is meaningful: it makes the mailbox send-only.
    imapHost: form.imapHost.trim() || null,
    imapPort: form.imapHost.trim() ? Number(form.imapPort) || 993 : null,
    imapUser: form.imapUser.trim(),
    ...(form.imapPassword ? { imapPassword: form.imapPassword } : {}),
    signature: form.signature,
    autoFollowUp: form.autoFollowUp,
    maxFollowUps: Number(form.maxFollowUps),
  });

  const save = useMutation({
    mutationFn: () => (isNew ? api.createEmailAccount(payload()) : api.updateEmailAccount(account.id, payload())),
    onSuccess: (data) => {
      if (data.verified) toast.success(`${data.account.email} verified.`);
      else toast.error(`Saved, but verification failed: ${data.account.lastError}`);
      queryClient.invalidateQueries({ queryKey: ["email-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["email-account"] });
      onDone();
    },
    onError: (err) => toast.error(err.message),
  });

  const canSave = form.email.trim() && form.smtpHost.trim() && (!isNew || form.appPassword);

  return (
    <div className="rounded-xl border border-[var(--border-strong)] bg-[var(--surface-sunken)] p-4">
      <p className="mb-3 text-xs font-semibold">{isNew ? "Connect a mailbox" : `Edit ${account.email}`}</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label="Provider">
          <Select value={form.provider} onChange={(e) => switchProvider(e.target.value)} className="w-full">
            {Object.entries(PROVIDERS).map(([key, p]) => <option key={key} value={key}>{p.label}</option>)}
          </Select>
        </Labelled>
        <Labelled label="Send from (address recipients see)">
          <Input type="email" className="w-full" value={form.email} onChange={(e) => set("email")(e.target.value)} placeholder="you@yourdomain.com" />
        </Labelled>
        <Labelled label={preset.secretLabel} hint={account ? "(saved — enter only to replace)" : null}>
          <Input type="password" className="w-full" value={form.appPassword} onChange={(e) => set("appPassword")(e.target.value)} placeholder={preset.secretPlaceholder} autoComplete="new-password" />
        </Labelled>
        <Labelled label="Sender name">
          <Input className="w-full" value={form.displayName} onChange={(e) => set("displayName")(e.target.value)} placeholder="Abdul Majid" />
        </Labelled>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">{preset.hint}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Labelled label="SMTP host"><Input className="w-full" value={form.smtpHost} onChange={(e) => set("smtpHost")(e.target.value)} placeholder="smtp.example.com" /></Labelled>
        <Labelled label="Port"><Input type="number" className="w-full" value={form.smtpPort} onChange={(e) => set("smtpPort")(e.target.value)} /></Labelled>
        <Labelled label="SMTP login" hint="(if not the address)"><Input className="w-full" value={form.smtpUser} onChange={(e) => set("smtpUser")(e.target.value)} placeholder="same as address" /></Labelled>
      </div>

      <div className="mt-4 rounded-lg border border-[var(--border)] p-3">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
          <Inbox size={11} />Reply tracking (optional)
        </p>
        <p className="mb-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
          The inbox replies actually land in. If this address forwards elsewhere — a domain address routed into Gmail,
          say — point this at the receiving mailbox. Leave the host empty for a send-only sender.
        </p>
        <div className="grid gap-3 sm:grid-cols-4">
          <Labelled label="IMAP host"><Input className="w-full" value={form.imapHost} onChange={(e) => set("imapHost")(e.target.value)} placeholder="imap.gmail.com" /></Labelled>
          <Labelled label="Port"><Input type="number" className="w-full" value={form.imapPort} onChange={(e) => set("imapPort")(e.target.value)} /></Labelled>
          <Labelled label="IMAP login"><Input className="w-full" value={form.imapUser} onChange={(e) => set("imapUser")(e.target.value)} placeholder="you@gmail.com" /></Labelled>
          <Labelled label="IMAP password" hint={account?.imapUser ? "(saved)" : null}>
            <Input type="password" className="w-full" value={form.imapPassword} onChange={(e) => set("imapPassword")(e.target.value)} placeholder="app password" autoComplete="new-password" />
          </Labelled>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Labelled label="Reply-to" hint="(optional)">
          <Input type="email" className="w-full" value={form.replyTo} onChange={(e) => set("replyTo")(e.target.value)} placeholder="replies@yourdomain.com" />
        </Labelled>
        <Labelled label="Max follow-ups per thread">
          <Input type="number" min="0" max="5" className="w-full" value={form.maxFollowUps} onChange={(e) => set("maxFollowUps")(e.target.value)} />
        </Labelled>
      </div>

      <div className="mt-3">
        <Labelled label="Signature (appended to every email from this mailbox)">
          <Textarea className="min-h-16 w-full" value={form.signature} onChange={(e) => set("signature")(e.target.value)} placeholder={"Abdul Majid\nhttps://your-site.com"} />
        </Labelled>
      </div>

      <label className="mt-3 flex items-center gap-2 text-[13px]">
        <input type="checkbox" className="accent-[var(--accent)]" checked={form.autoFollowUp} onChange={(e) => set("autoFollowUp")(e.target.checked)} />
        Send follow-ups automatically when there is no reply (after 3 days, then 7)
      </label>

      <div className="mt-4 flex items-center gap-2">
        <Button onClick={() => save.mutate()} disabled={save.isPending || !canSave}>
          {save.isPending ? <Spinner size={13} /> : null}{isNew ? "Connect and verify" : "Save and verify"}
        </Button>
        <Button variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
};

const AccountRow = ({ account, onEdit }) => {
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["email-accounts"] });
    queryClient.invalidateQueries({ queryKey: ["email-account"] });
  };

  const test = useMutation({
    mutationFn: () => api.testEmailAccountById(account.id),
    onSuccess: (data) => {
      if (data.ok) toast.success(account.canReceive ? "SMTP and IMAP both verified." : "SMTP verified (send-only mailbox).");
      else toast.error(`Verification failed: ${data.smtp.error || data.imap.error}`);
      invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const makeDefault = useMutation({
    mutationFn: () => api.setDefaultEmailAccount(account.id),
    onSuccess: (data) => { toast.success(data.message || "Default sender updated."); invalidate(); },
    onError: (err) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteEmailAccountById(account.id),
    onSuccess: () => { toast.success(`${account.email} disconnected.`); invalidate(); },
    onError: (err) => toast.error(err.message),
  });

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-medium">
            {account.displayName ? `${account.displayName} <${account.email}>` : account.email}
          </span>
          {account.isDefault && <Badge tone="var(--accent)"><Star size={10} />Default</Badge>}
          <Badge tone={account.status === "CONNECTED" ? "var(--color-positive)" : "var(--color-critical)"}>
            {account.status === "CONNECTED" ? <CheckCircle2 size={10} /> : <AlertCircle size={10} />}
            {account.status === "CONNECTED" ? "Connected" : "Error"}
          </Badge>
          <Badge>{PROVIDERS[account.provider]?.label || account.provider}</Badge>
        </div>
        <p className="mt-1 text-[11px] text-[var(--text-subtle)]">
          <Send size={10} className="mr-1 inline" />{account.smtpHost}:{account.smtpPort}
          {" · "}
          {account.canReceive
            ? <><Inbox size={10} className="mr-1 inline" />replies from {account.imapUser || account.email}</>
            : "send-only — replies are not tracked"}
          {account.lastSyncAt && ` · last sync ${formatDateTime(account.lastSyncAt)}`}
        </p>
        {account.lastError && (
          <p className="mt-1 text-[11px] leading-snug text-[var(--color-critical)]">{account.lastError}</p>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        {!account.isDefault && (
          <Button size="sm" variant="ghost" onClick={() => makeDefault.mutate()} disabled={makeDefault.isPending} title="Use as default sender">
            <Star size={13} />
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => test.mutate()} disabled={test.isPending} title="Test connection">
          {test.isPending ? <Spinner size={13} /> : <RefreshCw size={13} />}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit} title="Edit"><Pencil size={13} /></Button>
        <Button
          size="sm"
          variant="ghost"
          title="Disconnect"
          onClick={() => { if (window.confirm(`Disconnect ${account.email}? Threads sent from it will be removed.`)) remove.mutate(); }}
        >
          <Trash2 size={13} />
        </Button>
      </div>
    </li>
  );
};

export default function EmailAccountsSection() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(null); // account id, or "new"
  const { data, isPending } = useQuery({ queryKey: ["email-accounts"], queryFn: api.listEmailAccounts });
  const accounts = data?.accounts || [];

  const sync = useMutation({
    mutationFn: () => api.syncOutreach(),
    onSuccess: (res) => {
      toast.success(res?.sync?.replies ? `${res.sync.replies} new repl${res.sync.replies === 1 ? "y" : "ies"}.` : "No new replies yet.");
      queryClient.invalidateQueries({ queryKey: ["email-accounts"] });
      queryClient.invalidateQueries({ queryKey: ["outreach-threads"] });
    },
    onError: (err) => toast.error(err.message),
  });

  return (
    <Surface className="p-5">
      <SectionHeading
        icon={Mail}
        title="Email senders"
        description="Connect as many mailboxes as you like — you pick which one sends each email in the composer."
        actions={
          <div className="flex items-center gap-2">
            {accounts.length > 0 && (
              <Button size="sm" variant="secondary" onClick={() => sync.mutate()} disabled={sync.isPending}>
                <RefreshCw size={13} className={sync.isPending ? "animate-spin" : undefined} />Sync replies
              </Button>
            )}
            <Button size="sm" onClick={() => setEditing("new")}><Plus size={13} />Add mailbox</Button>
          </div>
        }
      />

      {isPending ? <Skeleton className="h-24" /> : (
        <div className="space-y-4">
          {accounts.length === 0 && editing !== "new" && (
            <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-3 text-xs leading-relaxed text-[var(--text-muted)]">
              No mailbox connected yet. Add one to send outreach from the app and have replies tracked automatically.
            </p>
          )}

          {accounts.length > 0 && (
            <ul className="divide-y divide-[var(--border)]">
              {accounts.map((a) => (
                editing === a.id
                  ? <li key={a.id} className="py-3"><AccountEditor account={a} onDone={() => setEditing(null)} /></li>
                  : <AccountRow key={a.id} account={a} onEdit={() => setEditing(a.id)} />
              ))}
            </ul>
          )}

          {editing === "new" && <AccountEditor account={null} onDone={() => setEditing(null)} />}

          <p className="border-t border-[var(--border)] pt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
            Credentials are stored in your own database and used only for the hosts you enter here. Suppressed
            contacts and do-not-contact leads are never emailed, including by follow-ups.
          </p>
        </div>
      )}
    </Surface>
  );
}
