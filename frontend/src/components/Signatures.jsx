import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PenLine, Plus, Star, Pencil, Trash2, Check } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { Badge, Button, Input, Skeleton, Spinner, Surface, SectionHeading } from "./ui.jsx";

/**
 * Reusable sign-offs. Several may exist; the composer picks one per message and
 * the starred one is pre-selected.
 *
 * Stored as fields rather than a blob of text so one row can render three ways
 * — a styled block in the email's HTML part, plain lines in its text part, and
 * two bare lines on WhatsApp. Every preview shown here is rendered by the
 * server from that same row, so what you see is literally what gets sent.
 */

const emptyForm = () => ({
  name: "",
  fullName: "",
  title: "",
  company: "",
  website: "",
  email: "",
  phone: "",
  tagline: "",
  accentColor: "#4f39f6",
  isDefault: false,
});

const formFrom = (s) => ({
  name: s.name,
  fullName: s.fullName,
  title: s.title || "",
  company: s.company || "",
  website: s.website || "",
  email: s.email || "",
  phone: s.phone || "",
  tagline: s.tagline || "",
  accentColor: s.accentColor || "#4f39f6",
  isDefault: s.isDefault,
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

/**
 * A faithful preview of the HTML block.
 *
 * Rendered inside a white, fixed-colour box rather than inheriting the app
 * theme: the recipient's mail client knows nothing about our CSS variables, so
 * previewing it in dark mode would show something no one will ever receive.
 */
const HtmlPreview = ({ html }) => (
  <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-white p-4">
    <div dangerouslySetInnerHTML={{ __html: html }} />
  </div>
);

const SignatureEditor = ({ signature, onDone }) => {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => (signature ? formFrom(signature) : emptyForm()));
  const isNew = !signature;
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        fullName: form.fullName.trim(),
        title: form.title.trim(),
        company: form.company.trim(),
        website: form.website.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        tagline: form.tagline.trim(),
        accentColor: form.accentColor,
        isDefault: form.isDefault,
      };
      return isNew ? api.createSignature(body) : api.updateSignature(signature.id, body);
    },
    onSuccess: (data) => {
      toast.success(data?.message || "Signature saved.");
      queryClient.invalidateQueries({ queryKey: ["signatures"] });
      queryClient.invalidateQueries({ queryKey: ["email-accounts"] });
      onDone();
    },
    onError: (err) => toast.error(err.message),
  });

  const canSave = form.name.trim() && form.fullName.trim() && !save.isPending;

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Labelled label="Name" hint="how you'll pick it">
          <Input className="w-full" value={form.name} onChange={(e) => set("name")(e.target.value)} placeholder="Abdul Majid — CTO" />
        </Labelled>
        <Labelled label="Full name">
          <Input className="w-full" value={form.fullName} onChange={(e) => set("fullName")(e.target.value)} placeholder="Abdul Majid" />
        </Labelled>
        <Labelled label="Title">
          <Input className="w-full" value={form.title} onChange={(e) => set("title")(e.target.value)} placeholder="CTO" />
        </Labelled>
        <Labelled label="Company">
          <Input className="w-full" value={form.company} onChange={(e) => set("company")(e.target.value)} placeholder="Deventia Tech" />
        </Labelled>
        <Labelled label="Website" hint="no https:// needed">
          <Input className="w-full" value={form.website} onChange={(e) => set("website")(e.target.value)} placeholder="deventiatech.com" />
        </Labelled>
        <Labelled label="Email">
          <Input className="w-full" type="email" value={form.email} onChange={(e) => set("email")(e.target.value)} placeholder="you@deventiatech.com" />
        </Labelled>
        <Labelled label="Phone">
          <Input className="w-full" value={form.phone} onChange={(e) => set("phone")(e.target.value)} placeholder="+966 5x xxx xxxx" />
        </Labelled>
        <Labelled label="Accent colour">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={form.accentColor}
              onChange={(e) => set("accentColor")(e.target.value)}
              aria-label="Accent colour"
              className="h-9 w-12 cursor-pointer rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] p-1"
            />
            <Input className="w-full font-mono" value={form.accentColor} onChange={(e) => set("accentColor")(e.target.value)} />
          </div>
        </Labelled>
      </div>

      <Labelled label="Tagline" hint="optional — one line under the block">
        <Input className="w-full" value={form.tagline} onChange={(e) => set("tagline")(e.target.value)} placeholder="Custom software, shipped." />
      </Labelled>

      <label className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        <input
          type="checkbox"
          checked={form.isDefault}
          onChange={(e) => set("isDefault")(e.target.checked)}
          className="size-3.5 accent-[var(--accent)]"
        />
        Use this as the default sign-off
      </label>

      <div className="flex items-center gap-2 border-t border-[var(--border)] pt-3">
        <Button onClick={() => save.mutate()} disabled={!canSave}>
          {save.isPending ? <Spinner size={13} /> : <Check size={13} />}
          {isNew ? "Add signature" : "Save changes"}
        </Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
};

const SignatureRow = ({ signature, onEdit }) => {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["signatures"] });
    queryClient.invalidateQueries({ queryKey: ["email-accounts"] });
  };

  const makeDefault = useMutation({
    mutationFn: () => api.setDefaultSignature(signature.id),
    onSuccess: (data) => { toast.success(data?.message || "Default updated."); invalidate(); },
    onError: (err) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteSignature(signature.id),
    onSuccess: (data) => { toast.success(data?.message || "Signature deleted."); invalidate(); },
    onError: (err) => toast.error(err.message),
  });

  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--surface-raised)]">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="truncate text-[13px] font-medium">{signature.name}</p>
            {signature.isDefault && (
              <Badge tone="var(--color-positive)"><Star size={9} />Default</Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-[11px] text-[var(--text-muted)]">
            {[signature.fullName, signature.title, signature.website].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Hide preview" : "Preview"}
          </Button>
          {!signature.isDefault && (
            <Button size="sm" variant="ghost" onClick={() => makeDefault.mutate()} disabled={makeDefault.isPending} title="Make default">
              <Star size={12} />
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onEdit} title="Edit"><Pencil size={12} /></Button>
          <Button
            size="sm" variant="ghost" title="Delete"
            onClick={() => {
              // Deleting only detaches it from any mailbox using it — worth
              // confirming, but it takes nothing else down with it.
              if (window.confirm(`Delete the "${signature.name}" signature?`)) remove.mutate();
            }}
            disabled={remove.isPending}
          >
            <Trash2 size={12} />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-[var(--border)] px-3.5 py-3">
          <div>
            <p className="mb-1.5 text-[10px] uppercase tracking-wide text-[var(--text-subtle)]">In an email</p>
            <HtmlPreview html={signature.preview.html} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-[10px] uppercase tracking-wide text-[var(--text-subtle)]">Plain-text fallback</p>
              <pre className="whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-3 font-[inherit] text-[12px] leading-snug text-[var(--text-muted)]">{signature.preview.text}</pre>
            </div>
            <div>
              <p className="mb-1.5 text-[10px] uppercase tracking-wide text-[var(--text-subtle)]">On WhatsApp</p>
              <pre className="whitespace-pre-wrap rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-3 font-[inherit] text-[12px] leading-snug text-[var(--text-muted)]">{signature.preview.whatsapp}</pre>
            </div>
          </div>
        </div>
      )}
    </li>
  );
};

export default function SignaturesSection() {
  const [editing, setEditing] = useState(null); // signature id, or "new"
  const { data, isPending } = useQuery({ queryKey: ["signatures"], queryFn: api.listSignatures });
  const signatures = data?.signatures || [];

  return (
    <Surface className="p-5">
      <SectionHeading
        icon={PenLine}
        title="Signatures"
        description="Sign-offs for email and WhatsApp. Pick one per message in the composer; the starred one is used unless you change it."
        actions={
          editing !== "new" && (
            <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
              <Plus size={13} />Add signature
            </Button>
          )
        }
      />

      {isPending ? <Skeleton className="h-20" /> : (
        <div className="space-y-3">
          {editing === "new" && <SignatureEditor signature={null} onDone={() => setEditing(null)} />}

          {signatures.length === 0 && editing !== "new" && (
            <p className="rounded-lg border border-dashed border-[var(--border-strong)] p-4 text-center text-xs text-[var(--text-muted)]">
              No signatures yet. Add one and every email and WhatsApp message gets signed automatically.
            </p>
          )}

          <ul className="space-y-2">
            {signatures.map((s) => (
              editing === s.id
                ? <li key={s.id}><SignatureEditor signature={s} onDone={() => setEditing(null)} /></li>
                : <SignatureRow key={s.id} signature={s} onEdit={() => setEditing(s.id)} />
            ))}
          </ul>

          <p className="border-t border-[var(--border)] pt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
            Emails go out as both HTML and plain text, so the styled block renders where it can and
            degrades to the text version where it cannot. WhatsApp gets the two-line form — a formatted
            block in a chat bubble reads as spam.
          </p>
        </div>
      )}
    </Surface>
  );
}
