import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft, Pencil, Mail, Phone, MessageCircle, Globe, MapPin, CalendarClock,
  UserRound, Building2, Star, Tag, Trash2, StickyNote,
} from "lucide-react";
import { PageBody } from "../App.jsx";
import { api } from "../lib/api.js";
import { ClientProjects } from "../components/ClientProjects.jsx";
import { ClientCheckIns } from "../components/ClientCheckIns.jsx";
import { ClientFormSheet } from "../components/ClientFormSheet.jsx";
import { Badge, Button, ErrorState, Field, SectionHeading, Skeleton, Surface } from "../components/ui.jsx";
import {
  CLIENT_STATUS_LABELS, CLIENT_STATUS_TONE, CONTACT_HEALTH,
  dialable, formatDate, prettyUrl, relativeTime, whatsappNumber,
} from "../lib/format.js";

/**
 * One client, in full.
 *
 * Laid out around the reason someone opens this page: they are about to talk to
 * this client. So the right rail answers "who do I call and when" and stays put,
 * while the wider column carries the substance of the conversation — the work
 * delivered and everything said so far.
 */

const linkProps = { target: "_blank", rel: "noreferrer noopener" };

/** Reach-out links, sized for a page rather than a card. */
const ContactActions = ({ contact, website }) => {
  const phone = dialable(contact?.phone);
  const wa = whatsappNumber(contact?.phone);
  const actions = [
    contact?.email && { href: `mailto:${contact.email}`, icon: Mail, label: "Email" },
    phone && { href: `tel:${phone}`, icon: Phone, label: "Call" },
    wa && { href: `https://wa.me/${wa}`, icon: MessageCircle, label: "WhatsApp", external: true },
    website && { href: website, icon: Globe, label: "Website", external: true },
  ].filter(Boolean);

  if (actions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {actions.map(({ href, icon: Icon, label, external }) => (
        <a
          key={label}
          href={href}
          {...(external ? linkProps : {})}
          className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-xs font-medium text-[var(--text)] shadow-[var(--shadow-xs)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          <Icon size={13} />{label}
        </a>
      ))}
    </div>
  );
};

const PersonRow = ({ contact }) => {
  const phone = dialable(contact.phone);
  const wa = whatsappNumber(contact.phone);

  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--surface-raised)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <UserRound size={13} className="text-[var(--text-subtle)]" />
        <span className="text-[13px] font-medium">{contact.name || contact.email || contact.phone}</span>
        {contact.role && <span className="text-[11px] text-[var(--text-muted)]">{contact.role}</span>}
        {contact.isPrimary && <Badge tone="var(--accent)"><Star size={9} />Main contact</Badge>}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        {contact.email && (
          <a href={`mailto:${contact.email}`} className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline">
            <Mail size={11} />{contact.email}
          </a>
        )}
        {phone && (
          <a href={`tel:${phone}`} className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline">
            <Phone size={11} />{contact.phone}
          </a>
        )}
        {wa && (
          <a href={`https://wa.me/${wa}`} {...linkProps} className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline">
            <MessageCircle size={11} />WhatsApp
          </a>
        )}
        {!contact.email && !phone && (
          <span className="text-[11px] text-[var(--text-subtle)]">No email or phone recorded.</span>
        )}
      </div>

      {contact.notes && <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">{contact.notes}</p>}
    </li>
  );
};

export default function ClientDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["client", id],
    queryFn: () => api.getClient(id),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteClient(id),
    onSuccess: (res) => {
      toast.success(res?.message || "Client removed.");
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["client-facets"] });
      navigate("/clients");
    },
    onError: (err) => toast.error(err.message),
  });

  if (isPending) {
    return (
      <PageBody className="space-y-4">
        <Skeleton className="h-24 rounded-xl" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-64 rounded-xl lg:col-span-2" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </PageBody>
    );
  }

  if (isError) return <PageBody><ErrorState error={error} onRetry={refetch} /></PageBody>;

  const client = data.client;
  const health = CONTACT_HEALTH[client.health.state] || CONTACT_HEALTH.RECENT;

  return (
    <div>
      <header className="border-b border-[var(--border)] bg-[var(--surface-raised)]">
        <div className="mx-auto max-w-6xl px-5 py-6 md:px-8">
          <Link to="/clients" className="inline-flex items-center gap-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text)]">
            <ArrowLeft size={13} />Back to clients
          </Link>

          <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-semibold tracking-tight">{client.name}</h1>
                <Badge tone={CLIENT_STATUS_TONE[client.status]}>{CLIENT_STATUS_LABELS[client.status]}</Badge>
                <Badge tone={health.tone}><CalendarClock size={9} />{health.label}</Badge>
              </div>

              <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-[var(--text-muted)]">
                {client.industry && <span className="inline-flex items-center gap-1"><Building2 size={11} />{client.industry}</span>}
                {(client.city || client.countryName) && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin size={11} />{[client.city, client.countryName].filter(Boolean).join(", ")}
                  </span>
                )}
                {client.website && (
                  <a href={client.website} {...linkProps} className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline">
                    <Globe size={11} />{prettyUrl(client.website)}
                  </a>
                )}
                {client.clientSince && <span>Client since {formatDate(client.clientSince)}</span>}
              </p>

              {client.tags.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {client.tags.map((tag) => (
                    <li key={tag} className="inline-flex items-center gap-1 rounded-md bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">
                      <Tag size={9} />{tag}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => setEditing(true)}><Pencil size={13} />Edit</Button>
            </div>
          </div>
        </div>
      </header>

      <PageBody className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <ClientProjects clientId={client.id} projects={client.projects} />
          <ClientCheckIns client={client} />
        </div>

        <aside className="space-y-5">
          {/* Who to call, and when — the reason this page gets opened. */}
          <Surface className="p-5">
            <SectionHeading icon={CalendarClock} title="Next step" />
            <dl className="space-y-3">
              <Field label="Status">
                <span style={{ color: health.tone }}>{health.label}</span>
              </Field>
              <Field label="Last spoke">
                {client.lastContactedAt
                  ? <span title={formatDate(client.lastContactedAt)}>{relativeTime(client.lastContactedAt)}</span>
                  : "Never — nothing logged yet"}
              </Field>
              <Field label="Next check-in">
                {client.nextFollowUpAt ? formatDate(client.nextFollowUpAt) : "Not booked — 90-day nudge applies"}
              </Field>
            </dl>

            {client.primaryContact && (
              <div className="mt-4 border-t border-[var(--border)] pt-4">
                <p className="mb-2 text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">Reach the main contact</p>
                <ContactActions contact={client.primaryContact} website={client.website} />
              </div>
            )}
          </Surface>

          <Surface className="p-5">
            <SectionHeading
              icon={UserRound}
              title="People"
              description={client.contacts.length ? `${client.contacts.length} at this client.` : undefined}
              actions={<Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Manage</Button>}
            />
            {client.contacts.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[var(--border-strong)] p-4 text-center text-xs text-[var(--text-muted)]">
                Nobody recorded yet. Add the people you actually speak to, so a check-in never stalls on “who do I email?”.
              </p>
            ) : (
              <ul className="space-y-2">
                {client.contacts.map((contact) => <PersonRow key={contact.id} contact={contact} />)}
              </ul>
            )}
          </Surface>

          {client.notes && (
            <Surface className="p-5">
              <SectionHeading icon={StickyNote} title="Notes" />
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text-muted)]">{client.notes}</p>
            </Surface>
          )}

          {/* Destructive, cascading and last — with the consequences spelled
              out, because a browser confirm cannot list what else goes. */}
          <Surface className="border-[color-mix(in_oklch,var(--color-critical)_25%,var(--border))] p-5">
            <SectionHeading icon={Trash2} title="Remove this client" description="Permanent. There is no undo." />
            {confirmingDelete ? (
              <div className="space-y-3">
                <p className="rounded-lg border border-[color-mix(in_oklch,var(--color-critical)_30%,transparent)] bg-[color-mix(in_oklch,var(--color-critical)_8%,transparent)] p-3 text-xs leading-relaxed text-[var(--text)]">
                  Deleting <strong>{client.name}</strong> also deletes{" "}
                  {client.contacts.length} {client.contacts.length === 1 ? "person" : "people"},{" "}
                  {client.projects.length} {client.projects.length === 1 ? "project" : "projects"} and{" "}
                  {client.touchpoints.length} logged {client.touchpoints.length === 1 ? "check-in" : "check-ins"}.
                  Archiving keeps the record but hides it everywhere.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
                    {remove.isPending ? "Deleting…" : "Delete permanently"}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="danger" size="sm" onClick={() => setConfirmingDelete(true)}>
                  <Trash2 size={13} />Delete client
                </Button>
                {client.status !== "ARCHIVED" && (
                  <span className="text-[11px] text-[var(--text-muted)]">
                    Prefer to keep the history? Set the status to Archived instead.
                  </span>
                )}
              </div>
            )}
          </Surface>
        </aside>
      </PageBody>

      <ClientFormSheet
        open={editing}
        onClose={() => setEditing(false)}
        client={client}
        tagSuggestions={client.tags}
      />
    </div>
  );
}
