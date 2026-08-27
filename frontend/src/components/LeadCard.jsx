import { Link } from "react-router-dom";
import { Mail, Phone, FileText, MapPin, ArrowRight, Sparkles, ShieldAlert, User } from "lucide-react";
import { Badge, ScoreRing, Surface } from "./ui.jsx";
import {
  SERVICE_LABELS, LEAD_TYPE_LABELS, CONFIDENCE_STYLES,
  scoreTone, freshnessTone, cn,
} from "../lib/format.js";

/**
 * The unit of the product. It has to answer four questions at a glance:
 * how good, why, how fresh, and what to do next.
 */
export const LeadCard = ({ lead, selectable = false, selected = false, onToggleSelect }) => {
  const tone = scoreTone(lead.score);
  const fresh = freshnessTone(lead.freshness.bucket);

  return (
    <Surface
      className={cn(
        "group relative transition-colors hover:border-[var(--border-strong)]",
        selected && "border-[var(--accent)] ring-1 ring-[color-mix(in_oklch,var(--accent)_35%,transparent)]",
      )}
    >
      {/* Selection sits outside the Link so ticking a lead never navigates. */}
      {selectable && (
        <label
          className="absolute right-3 top-3 z-10 flex size-8 cursor-pointer items-center justify-center rounded-lg hover:bg-[var(--surface-sunken)]"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect?.(lead)}
            aria-label={`Select ${lead.company.name}`}
            className="size-4 cursor-pointer accent-[var(--accent)]"
          />
        </label>
      )}
      <Link to={`/leads/${lead.id}`} className={cn("block p-4 focus-visible:outline-none", selectable && "pr-12")}>
        <div className="flex gap-4">
          <ScoreRing score={lead.score} tone={tone} />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="truncate text-[15px] font-semibold tracking-tight">{lead.company.name}</h3>
              <Badge tone={tone}>{SERVICE_LABELS[lead.primaryOpportunity] || lead.primaryOpportunity}</Badge>
              <Badge>{LEAD_TYPE_LABELS[lead.type] || lead.type}</Badge>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-muted)]">
              {lead.company.industry && <span>{lead.company.industry}</span>}
              {(lead.company.city || lead.company.countryCode) && (
                <span className="inline-flex items-center gap-1">
                  <MapPin size={11} />
                  {[lead.company.city, lead.company.countryCode].filter(Boolean).join(" · ")}
                </span>
              )}
              {lead.company.domain && (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <span className="truncate font-mono text-[11px]">{lead.company.domain}</span>
                  {/* A website we could not tie to this business is the one thing
                      worth interrupting the scan for — every contact detail
                      taken from it may belong to somebody else. */}
                  {lead.company.domainIdentityStatus === "WEAK" && (
                    <span
                      className="inline-flex items-center gap-0.5 text-[var(--color-caution)]"
                      title="This site never identifies itself as this business. Verify before contacting."
                    >
                      <ShieldAlert size={11} aria-hidden="true" />
                      <span className="sr-only">Website ownership unverified</span>
                    </span>
                  )}
                </span>
              )}
              <span className="inline-flex items-center gap-1" style={{ color: fresh }}>
                <span className="size-1.5 rounded-full" style={{ background: fresh }} />
                {lead.freshness.relative}
              </span>
            </div>

            {lead.topReasons?.length > 0 && (
              <ul className="mt-2.5 space-y-1">
                {lead.topReasons.slice(0, 3).map((reason, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] leading-snug text-[var(--text-muted)]">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--border-strong)]" />
                    <span className="min-w-0">
                      {reason.text}
                      {reason.confidenceLevel !== "DETECTED" && (
                        <span className={cn("ml-1.5 rounded px-1 py-px text-[10px] font-medium", CONFIDENCE_STYLES[reason.confidenceLevel]?.className)}>
                          {CONFIDENCE_STYLES[reason.confidenceLevel]?.label}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                {lead.contact.email && (
                  <span className="inline-flex items-center gap-1.5 truncate" title={lead.contact.email}>
                    <Mail size={12} className="text-[var(--color-positive)]" />
                    <span className="max-w-[190px] truncate">{lead.contact.email}</span>
                  </span>
                )}
                {lead.contact.phone && (
                  <span className="inline-flex items-center gap-1.5">
                    <Phone size={12} className="text-[var(--color-positive)]" />{lead.contact.phone}
                  </span>
                )}
                {!lead.contact.email && !lead.contact.phone && lead.contact.hasForm && (
                  <span className="inline-flex items-center gap-1.5"><FileText size={12} />Contact form</span>
                )}
                {!lead.contact.email && !lead.contact.phone && !lead.contact.hasForm && (
                  <span className="text-[var(--text-subtle)]">No contact route found</span>
                )}
                {lead.contact.personName && (
                  <span
                    className="inline-flex items-center gap-1.5 truncate"
                    title={[lead.contact.personName, lead.contact.personTitle].filter(Boolean).join(" — ")}
                  >
                    <User size={12} className="text-[var(--accent)]" />
                    <span className="max-w-[150px] truncate">{lead.contact.personName}</span>
                  </span>
                )}
              </div>

              {lead.recommendedAction && (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-[var(--surface-sunken)] px-2 py-1 text-[11px] font-medium text-[var(--text)]">
                  <Sparkles size={11} className="text-[var(--accent)]" />
                  {lead.recommendedAction.title}
                  <ArrowRight size={11} className="text-[var(--text-subtle)] transition-transform group-hover:translate-x-0.5" />
                </span>
              )}
            </div>
          </div>
        </div>
      </Link>
    </Surface>
  );
};
