import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Plus, Star, Trash2, Check, UserRound, Building2, CalendarClock, Tag } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { Button, FormField, Input, Select, Spinner, Textarea } from "./ui.jsx";
import { CLIENT_STATUS_HINTS, CLIENT_STATUS_LABELS, cn, toDateInput } from "../lib/format.js";
import { COUNTRY_OPTIONS } from "../lib/countries.js";

/**
 * The one place a client is created or edited.
 *
 * Shared by the list and the detail page rather than duplicated, so the
 * validation rules, the helper copy and the field order can only ever be right
 * or wrong in one place.
 *
 * Only the name is required. Everything else is optional by design: the book is
 * worth more with twenty half-filled clients in it than with three perfect ones
 * and the rest still in someone's head.
 */

/**
 * React keys for the repeater rows. A plain counter rather than
 * `crypto.randomUUID`, which is only defined in a secure context — the key just
 * has to be stable and unique within one open form, and this always is.
 */
let rowSeq = 0;
const nextKey = () => `row-${++rowSeq}`;

const emptyContact = () => ({ key: nextKey(), id: undefined, name: "", role: "", email: "", phone: "", notes: "", isPrimary: false });

const emptyForm = () => ({
  name: "",
  status: "PAST",
  website: "",
  industry: "",
  city: "",
  countryCode: "",
  clientSince: "",
  nextFollowUpAt: "",
  tags: [],
  notes: "",
  contacts: [{ ...emptyContact(), isPrimary: true }],
});

const formFrom = (client) => ({
  name: client.name || "",
  status: client.status || "PAST",
  website: client.website || "",
  industry: client.industry || "",
  city: client.city || "",
  countryCode: client.countryCode || "",
  clientSince: toDateInput(client.clientSince),
  nextFollowUpAt: toDateInput(client.nextFollowUpAt),
  tags: client.tags || [],
  notes: client.notes || "",
  contacts: (client.contacts?.length ? client.contacts : [{ ...emptyContact(), isPrimary: true }]).map((c) => ({
    key: c.id || nextKey(),
    id: c.id,
    name: c.name || "",
    role: c.role || "",
    email: c.email || "",
    phone: c.phone || "",
    notes: c.notes || "",
    isPrimary: Boolean(c.isPrimary),
  })),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Client-side validation exists to answer faster than the server can, never to
 * replace it — every rule here is enforced again in the controller.
 */
const validate = (form) => {
  const errors = {};
  if (form.name.trim().length < 2) errors.name = "Enter the client's name — at least 2 characters.";
  if (form.website.trim() && !/^[^\s]+\.[^\s]{2,}/.test(form.website.trim().replace(/^https?:\/\//i, ""))) {
    errors.website = "Enter a web address like acme.com.";
  }
  if (form.clientSince && form.nextFollowUpAt && form.nextFollowUpAt < form.clientSince) {
    errors.nextFollowUpAt = "The follow-up date cannot be before the relationship started.";
  }

  const contacts = {};
  form.contacts.forEach((c, i) => {
    if (c.email.trim() && !EMAIL_RE.test(c.email.trim())) contacts[i] = "That does not look like an email address.";
  });
  if (Object.keys(contacts).length) errors.contacts = contacts;
  return errors;
};

/** A repeater row does not need saving unless it can identify or reach someone. */
const isFilled = (c) => Boolean(c.name.trim() || c.email.trim() || c.phone.trim());

const TagEditor = ({ tags, onChange, suggestions = [] }) => {
  const [draft, setDraft] = useState("");

  const add = (raw) => {
    const tag = raw.trim().toLowerCase().slice(0, 32);
    if (!tag || tags.includes(tag) || tags.length >= 12) return;
    onChange([...tags, tag]);
    setDraft("");
  };

  const unused = suggestions.filter((s) => !tags.includes(s)).slice(0, 6);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // Enter must not submit the surrounding form — it adds a tag.
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(draft); }
            if (e.key === "Backspace" && !draft && tags.length) onChange(tags.slice(0, -1));
          }}
          placeholder="retainer, referral, saudi…"
          maxLength={32}
          disabled={tags.length >= 12}
        />
        <Button type="button" variant="secondary" onClick={() => add(draft)} disabled={!draft.trim() || tags.length >= 12}>
          <Plus size={13} />Add
        </Button>
      </div>

      {tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                onClick={() => onChange(tags.filter((t) => t !== tag))}
                className="inline-flex items-center gap-1 rounded-md bg-[var(--accent-soft)] px-2 py-1 text-[11px] font-medium text-[var(--accent)] transition-colors hover:brightness-95"
              >
                <Tag size={9} />{tag}
                <X size={10} aria-label={`Remove ${tag}`} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {unused.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-[var(--text-subtle)]">Used before</span>
          {unused.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const ContactRow = ({ contact, index, error, onChange, onRemove, onMakePrimary, canRemove }) => {
  const set = (key) => (value) => onChange({ ...contact, [key]: value });

  return (
    <li className={cn(
      "space-y-3 rounded-lg border p-3",
      contact.isPrimary
        ? "border-[color-mix(in_oklch,var(--accent)_40%,var(--border))] bg-[var(--accent-soft)]"
        : "border-[var(--border)] bg-[var(--surface-raised)]",
    )}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
          <UserRound size={11} />
          {contact.isPrimary ? "Main contact" : `Team member ${index}`}
        </span>
        <div className="flex items-center gap-1">
          {!contact.isPrimary && (
            <Button type="button" variant="ghost" size="sm" onClick={onMakePrimary} title="Make this the main contact">
              <Star size={11} />Make main
            </Button>
          )}
          {canRemove && (
            <Button type="button" variant="ghost" size="sm" onClick={onRemove} title="Remove this person">
              <Trash2 size={11} /><span className="sr-only">Remove</span>
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Name">
          {(a) => <Input {...a} value={contact.name} onChange={(e) => set("name")(e.target.value)} placeholder="Sara Al-Otaibi" maxLength={120} />}
        </FormField>
        <FormField label="Role" hint="optional">
          {(a) => <Input {...a} value={contact.role} onChange={(e) => set("role")(e.target.value)} placeholder="Operations Manager" maxLength={120} />}
        </FormField>
        <FormField label="Email" error={error}>
          {(a) => <Input {...a} type="email" value={contact.email} onChange={(e) => set("email")(e.target.value)} placeholder="sara@acme.com" maxLength={255} />}
        </FormField>
        <FormField label="Phone" help="Include the country code so calls and WhatsApp work.">
          {(a) => <Input {...a} type="tel" value={contact.phone} onChange={(e) => set("phone")(e.target.value)} placeholder="+966 50 123 4567" maxLength={40} />}
        </FormField>
      </div>

      <FormField label="Note" hint="optional" help="Anything worth remembering — best time to call, who they report to.">
        {(a) => <Input {...a} value={contact.notes} onChange={(e) => set("notes")(e.target.value)} placeholder="Signs off on budget. Prefers WhatsApp." maxLength={500} />}
      </FormField>
    </li>
  );
};

export const ClientFormSheet = ({ open, onClose, client, tagSuggestions = [], onSaved }) => {
  const queryClient = useQueryClient();
  const isEdit = Boolean(client);
  const [form, setForm] = useState(emptyForm);
  const [touched, setTouched] = useState(false);
  // Which record the open form was seeded from. Guards against re-seeding
  // mid-edit: React Query refetches on window focus, and reacting to a new
  // `client` object identity would silently discard whatever was being typed
  // when the user tabbed away and back.
  const [seededFor, setSeededFor] = useState(null);

  useEffect(() => {
    if (!open) {
      if (seededFor !== null) setSeededFor(null);
      return;
    }
    const target = client?.id || "new";
    if (seededFor === target) return;
    setForm(client ? formFrom(client) : emptyForm());
    setTouched(false);
    setSeededFor(target);
  }, [open, client, seededFor]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [open, onClose]);

  const errors = useMemo(() => validate(form), [form]);
  const hasErrors = Object.keys(errors).length > 0;
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));

  const setContact = (index) => (next) =>
    setForm((f) => ({ ...f, contacts: f.contacts.map((c, i) => (i === index ? next : c)) }));

  const makePrimary = (index) =>
    setForm((f) => ({ ...f, contacts: f.contacts.map((c, i) => ({ ...c, isPrimary: i === index })) }));

  const removeContact = (index) =>
    setForm((f) => {
      const contacts = f.contacts.filter((_, i) => i !== index);
      // The list must never be left without a main contact.
      if (contacts.length && !contacts.some((c) => c.isPrimary)) contacts[0] = { ...contacts[0], isPrimary: true };
      return { ...f, contacts: contacts.length ? contacts : [{ ...emptyContact(), isPrimary: true }] };
    });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        status: form.status,
        website: form.website.trim(),
        industry: form.industry.trim(),
        city: form.city.trim(),
        countryCode: form.countryCode,
        notes: form.notes.trim(),
        tags: form.tags,
        clientSince: form.clientSince,
        nextFollowUpAt: form.nextFollowUpAt,
        contacts: form.contacts.filter(isFilled).map((c) => ({
          id: c.id,
          name: c.name.trim(),
          role: c.role.trim(),
          email: c.email.trim(),
          phone: c.phone.trim(),
          notes: c.notes.trim(),
          isPrimary: c.isPrimary,
        })),
      };
      return isEdit ? api.updateClient(client.id, body) : api.createClient(body);
    },
    onSuccess: (data) => {
      toast.success(data?.message || "Saved.");
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["client-facets"] });
      if (isEdit) queryClient.invalidateQueries({ queryKey: ["client", client.id] });
      onSaved?.(data?.client);
      onClose();
    },
    onError: (err) => toast.error(err.message),
  });

  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (hasErrors) {
      toast.error("Some fields need attention before this can be saved.");
      return;
    }
    save.mutate();
  };

  if (!open) return null;
  const show = (key) => (touched ? errors[key] : undefined);
  const filledContacts = form.contacts.filter(isFilled).length;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[3px]" onClick={onClose} aria-hidden />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? `Edit ${client.name}` : "Add a client"}
        className="relative flex h-full w-full max-w-2xl flex-col border-l border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--shadow-lg)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">{isEdit ? `Edit ${client.name}` : "Add a client"}</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              Only the name is required. Fill in what you know — you can always come back and add the rest.
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--surface-sunken)]" aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
            {/* ── Who they are ── */}
            <section className="space-y-3">
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                <Building2 size={11} />The client
              </h3>

              <FormField
                label="Client name" required error={show("name")}
                help="The company as you refer to it. Used to spot duplicates, so keep it consistent."
              >
                {(a) => (
                  <Input {...a} value={form.name} onChange={(e) => set("name")(e.target.value)}
                    onBlur={() => setTouched(true)} placeholder="Acme Trading Co." maxLength={200} autoFocus />
                )}
              </FormField>

              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Relationship" help={CLIENT_STATUS_HINTS[form.status]}>
                  {(a) => (
                    <Select {...a} value={form.status} onChange={(e) => set("status")(e.target.value)}>
                      {Object.entries(CLIENT_STATUS_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </Select>
                  )}
                </FormField>

                <FormField label="Website" hint="optional" error={show("website")} help="No https:// needed.">
                  {(a) => <Input {...a} value={form.website} onChange={(e) => set("website")(e.target.value)} placeholder="acme.com" maxLength={500} />}
                </FormField>

                <FormField label="Industry" hint="optional">
                  {(a) => <Input {...a} value={form.industry} onChange={(e) => set("industry")(e.target.value)} placeholder="Logistics" maxLength={120} />}
                </FormField>

                <FormField label="City" hint="optional">
                  {(a) => <Input {...a} value={form.city} onChange={(e) => set("city")(e.target.value)} placeholder="Riyadh" maxLength={120} />}
                </FormField>

                <FormField label="Country" hint="optional">
                  {(a) => (
                    <Select {...a} value={form.countryCode} onChange={(e) => set("countryCode")(e.target.value)}>
                      <option value="">Not recorded</option>
                      {COUNTRY_OPTIONS.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                    </Select>
                  )}
                </FormField>

                <FormField label="Client since" hint="optional" help="When the relationship began, not when you added them here.">
                  {(a) => <Input {...a} type="date" value={form.clientSince} onChange={(e) => set("clientSince")(e.target.value)} max={toDateInput(Date.now())} />}
                </FormField>
              </div>

              <FormField label="Tags" hint="optional" help="Up to 12. Press Enter to add. Handy for slicing the list later.">
                {() => <TagEditor tags={form.tags} onChange={set("tags")} suggestions={tagSuggestions} />}
              </FormField>
            </section>

            {/* ── Who to talk to ── */}
            <section className="space-y-3 border-t border-[var(--border)] pt-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                    <UserRound size={11} />People
                  </h3>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    Add everyone worth calling. The main contact shows on the client card; the rest are there for
                    when they are on leave or have moved on.
                  </p>
                </div>
                <Button type="button" variant="secondary" size="sm" onClick={() => setForm((f) => ({ ...f, contacts: [...f.contacts, emptyContact()] }))}>
                  <Plus size={13} />Add person
                </Button>
              </div>

              <ul className="space-y-2">
                {form.contacts.map((contact, i) => (
                  <ContactRow
                    key={contact.key}
                    contact={contact}
                    index={i}
                    error={touched ? errors.contacts?.[i] : undefined}
                    onChange={setContact(i)}
                    onRemove={() => removeContact(i)}
                    onMakePrimary={() => makePrimary(i)}
                    canRemove={form.contacts.length > 1}
                  />
                ))}
              </ul>
              <p className="text-[11px] text-[var(--text-subtle)]">
                Blank rows are ignored — nothing is saved for a person with no name, email or phone.
              </p>
            </section>

            {/* ── Staying in touch ── */}
            <section className="space-y-3 border-t border-[var(--border)] pt-5">
              <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                <CalendarClock size={11} />Staying in touch
              </h3>

              <FormField
                label="Next check-in" hint="optional" error={show("nextFollowUpAt")}
                help="Set a date and this client appears under “Needs a check-in” when it arrives. Leave it empty and the book nudges you after 90 quiet days."
              >
                {(a) => <Input {...a} type="date" value={form.nextFollowUpAt} onChange={(e) => set("nextFollowUpAt")(e.target.value)} />}
              </FormField>

              <FormField label="Notes" hint="optional" help="Context that is not a project: how you met, who signs off, billing quirks.">
                {(a) => (
                  <Textarea {...a} rows={4} value={form.notes} onChange={(e) => set("notes")(e.target.value)} maxLength={4000}
                    placeholder="Introduced by Khalid at Nartec. Invoices go to finance@, always net-30." />
                )}
              </FormField>
            </section>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-5 py-4">
            <p className="text-[11px] text-[var(--text-muted)]">
              {filledContacts > 0
                ? `${filledContacts} ${filledContacts === 1 ? "person" : "people"} will be saved with this client.`
                : "No people added yet — you can add them any time."}
            </p>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={save.isPending || (touched && hasErrors)}>
                {save.isPending ? <Spinner size={13} /> : <Check size={13} />}
                {isEdit ? "Save changes" : "Add client"}
              </Button>
            </div>
          </footer>
        </form>
      </aside>
    </div>
  );
};
