import { Link } from "react-router-dom";
import { Mail, Phone, MessageCircle, Globe, MapPin, FolderGit2, UserRound, CalendarClock, ExternalLink } from "lucide-react";
import { Badge } from "./ui.jsx";
import {
  CLIENT_STATUS_LABELS, CLIENT_STATUS_TONE, CONTACT_HEALTH, PROJECT_STATUS_LABELS,
  cn, dialable, formatDate, prettyUrl, relativeTime, whatsappNumber,
} from "../lib/format.js";

/**
 * One client, as a scannable card.
 *
 * Ordered by the question it answers, top to bottom: who are they, is anything
 * owed, how do I reach them, what did we build. The reach-out row is the only
 * interactive part besides the card link itself — one click from remembering a
 * client to actually contacting them is the entire point of the book.
 */

/** `rel="noreferrer"` on every outbound link: these URLs are user-entered. */
const linkProps = { target: "_blank", rel: "noreferrer noopener" };

const QuickAction = ({ href, icon: Icon, label, external }) => (
  <a
    href={href}
    {...(external ? linkProps : {})}
    onClick={(e) => e.stopPropagation()}
    title={label}
    aria-label={label}
    className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
  >
    <Icon size={12} />
    <span className="hidden sm:inline">{label}</span>
  </a>
);

export const ClientCard = ({ client }) => {
  const health = CONTACT_HEALTH[client.health.state] || CONTACT_HEALTH.RECENT;
  const contact = client.primaryContact;
  const phone = dialable(contact?.phone);
  const wa = whatsappNumber(contact?.phone);

  return (
    <article
      className={cn(
        "group relative flex flex-col gap-3 rounded-xl border bg-[var(--surface-raised)] p-4 shadow-[var(--shadow-sm)] transition-all",
        "hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-md)]",
        health.urgent ? "border-[color-mix(in_oklch,var(--accent)_35%,var(--border))]" : "border-[var(--border)]",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Stretched link: the whole card opens the client, while the quick
              actions below sit above it and keep their own click. */}
          <h3 className="truncate text-[15px] font-semibold tracking-tight">
            <Link to={`/clients/${client.id}`} className="after:absolute after:inset-0 hover:text-[var(--accent)] focus-visible:underline">
              {client.name}
            </Link>
          </h3>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--text-muted)]">
            {client.industry && <span>{client.industry}</span>}
            {(client.city || client.countryName) && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={10} />{[client.city, client.countryName].filter(Boolean).join(", ")}
              </span>
            )}
            {client.clientSince && <span>Client since {formatDate(client.clientSince)}</span>}
          </p>
        </div>
        <Badge tone={CLIENT_STATUS_TONE[client.status]}>{CLIENT_STATUS_LABELS[client.status]}</Badge>
      </div>

      {/* ── Is anything owed here? ── */}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <Badge tone={health.tone}><CalendarClock size={9} />{health.label}</Badge>
        <span className="text-[var(--text-subtle)]">
          {client.health.state === "NEVER_CONTACTED"
            ? "No check-in logged yet"
            : client.lastContactedAt
              ? `Last spoke ${relativeTime(client.lastContactedAt)}`
              : "No check-in logged yet"}
          {client.nextFollowUpAt && ` · next ${formatDate(client.nextFollowUpAt)}`}
        </span>
      </div>

      {/* ── How do I reach them? ── */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-2.5">
        {contact ? (
          <>
            <p className="flex items-center gap-1.5 text-[12px] font-medium">
              <UserRound size={11} className="text-[var(--text-subtle)]" />
              {contact.name || contact.email || contact.phone}
              {contact.role && <span className="font-normal text-[var(--text-muted)]">· {contact.role}</span>}
              {client.teamSize > 1 && (
                <span className="ml-auto text-[10px] text-[var(--text-subtle)]">
                  +{client.teamSize - 1} more
                </span>
              )}
            </p>
            <div className="relative z-10 mt-2 flex flex-wrap gap-1.5">
              {contact.email && <QuickAction href={`mailto:${contact.email}`} icon={Mail} label="Email" />}
              {phone && <QuickAction href={`tel:${phone}`} icon={Phone} label="Call" />}
              {wa && <QuickAction href={`https://wa.me/${wa}`} icon={MessageCircle} label="WhatsApp" external />}
              {client.website && <QuickAction href={client.website} icon={Globe} label={prettyUrl(client.website)} external />}
              {!contact.email && !phone && !client.website && (
                <span className="text-[11px] text-[var(--text-subtle)]">No email or phone recorded yet.</span>
              )}
            </div>
          </>
        ) : (
          <p className="text-[11px] text-[var(--text-subtle)]">
            No people recorded. Open the client to add someone to call.
          </p>
        )}
      </div>

      {/* ── What did we build? ── */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1">
          <FolderGit2 size={11} className="text-[var(--text-subtle)]" />
          {client.projectCount === 0 ? "No projects recorded" : `${client.projectCount} project${client.projectCount === 1 ? "" : "s"}`}
        </span>
        {client.latestProject && (
          <>
            <span className="text-[var(--text-subtle)]">·</span>
            <span className="min-w-0 truncate font-medium text-[var(--text)]">{client.latestProject.name}</span>
            <Badge>{PROJECT_STATUS_LABELS[client.latestProject.status]}</Badge>
            {client.latestProject.url && (
              <a
                href={client.latestProject.url}
                {...linkProps}
                onClick={(e) => e.stopPropagation()}
                className="relative z-10 inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
              >
                <ExternalLink size={10} />Open
              </a>
            )}
          </>
        )}
      </div>

      {client.tags.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {client.tags.map((tag) => (
            <li key={tag} className="rounded-md bg-[var(--surface-sunken)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
              {tag}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
};
