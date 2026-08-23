import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Mail, Phone, Globe, MapPin, Briefcase, ShieldCheck, Layers,
  GitBranch, Copy, ExternalLink, Sparkles, Clock, AlertTriangle, Check,
} from "lucide-react";
import { toast } from "sonner";
import { PageBody } from "../App.jsx";
import { api } from "../lib/api.js";
import {
  Badge, Button, ErrorState, Field, ScoreRing, SectionHeading, Skeleton, Surface,
} from "../components/ui.jsx";
import { ProvenanceDrawer } from "../components/ProvenanceDrawer.jsx";
import EmailComposer, { ThreadStatusChip } from "../components/EmailComposer.jsx";
import {
  SERVICE_LABELS, LEAD_TYPE_LABELS, STATUS_LABELS, ACTION_LABELS, JOB_STATUS_LABELS,
  CONFIDENCE_STYLES, scoreTone, freshnessTone, formatDate, formatDateTime, titleize, cn,
} from "../lib/format.js";

const SEVERITY_TONE = {
  CRITICAL: "var(--color-critical)",
  HIGH: "var(--color-critical)",
  MEDIUM: "var(--color-caution)",
  LOW: "var(--color-ink-400)",
};

const JOB_STATUS_TONE = {
  ACTIVE: "var(--color-positive)",
  RECENTLY_ACTIVE: "var(--color-info)",
  EXPIRED: "var(--color-ink-400)",
  CLOSED: "var(--color-ink-400)",
  UNKNOWN: "var(--color-caution)",
};

const copy = (text, label) => {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`${label} copied`),
    () => toast.error("Could not copy to clipboard"),
  );
};

export default function LeadDetailPage() {
  const { id } = useParams();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: lead, isPending, isError, error, refetch } = useQuery({
    queryKey: ["lead", id],
    queryFn: () => api.getLead(id),
  });

  const { data: threadsData } = useQuery({
    queryKey: ["outreach-threads", id],
    queryFn: () => api.listThreads(id),
  });
  const activeThread = threadsData?.threads?.[0] || null;

  const statusMutation = useMutation({
    mutationFn: (status) => api.updateLeadStatus(id, { status }),
    onSuccess: (_, status) => {
      toast.success(`Marked ${STATUS_LABELS[status]?.toLowerCase()}`);
      queryClient.invalidateQueries({ queryKey: ["lead", id] });
      queryClient.invalidateQueries({ queryKey: ["leads"] });
    },
    onError: (err) => toast.error(err.message),
  });

  if (isPending) {
    return (
      <PageBody className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </PageBody>
    );
  }
  if (isError) return <PageBody><ErrorState error={error} onRetry={refetch} /></PageBody>;

  const tone = scoreTone(lead.score);
  const breakdown = lead.scoreBreakdown || {};
  const categories = breakdown.categories || {};
  const caps = breakdown.caps || { opportunity: 50, freshness: 25, reachability: 15, fit: 10 };
  const outreach = lead.outreach?.[0];
  const primaryAction = lead.actions?.[0];

  return (
    <div>
      <div className="border-b border-[var(--border)] bg-[var(--surface-raised)]">
        <div className="mx-auto max-w-6xl px-5 py-6 md:px-8">
          <Link to="/leads" className="mb-4 inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">
            <ArrowLeft size={13} />Back to leads
          </Link>

          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="flex items-start gap-4">
              <ScoreRing score={lead.score} tone={tone} size={62} stroke={5} />
              <div>
                <h1 className="text-xl font-semibold tracking-tight">{lead.company.name}</h1>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--text-muted)]">
                  {lead.company.industry && <span>{lead.company.industry}</span>}
                  {lead.company.city && <span className="inline-flex items-center gap-1"><MapPin size={12} />{lead.company.city}</span>}
                  {lead.company.domains[0] && (
                    <a
                      href={`https://${lead.company.domains[0].domain}`}
                      target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-[13px] text-[var(--accent)] hover:underline"
                    >
                      <Globe size={12} />{lead.company.domains[0].domain}<ExternalLink size={10} />
                    </a>
                  )}
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <Badge tone={tone}>{SERVICE_LABELS[lead.primaryOpportunity]}</Badge>
                  <Badge>{LEAD_TYPE_LABELS[lead.type]}</Badge>
                  <Badge tone={freshnessTone(lead.freshness.bucket)}>
                    <Clock size={10} />Evidence {lead.freshness.relative}
                  </Badge>
                  <Badge>{STATUS_LABELS[lead.status]}</Badge>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setDrawerOpen(true)}>
                <GitBranch size={13} />Where did this come from?
              </Button>
              <select
                value={lead.status}
                onChange={(e) => statusMutation.mutate(e.target.value)}
                disabled={statusMutation.isPending}
                aria-label="Lead status"
                className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2.5 py-2 text-[13px] outline-none transition-colors focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)] shadow-[var(--shadow-xs)]"
              >
                {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      <PageBody className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* ── Why this is a lead ─────────────────────────────────────────── */}
          <Surface className="p-5">
            <SectionHeading
              icon={Sparkles}
              title="Why this is a lead"
              description="Each statement is derived from evidence the system actually collected."
            />
            <ol className="space-y-2.5">
              {lead.reasons.map((reason) => (
                <li key={reason.rank} className="flex items-start gap-3">
                  <span className="tnum mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md bg-[var(--surface-sunken)] text-[11px] font-semibold text-[var(--text-muted)]">
                    {reason.rank}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-relaxed">{reason.text}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", CONFIDENCE_STYLES[reason.confidenceLevel]?.className)}>
                        {CONFIDENCE_STYLES[reason.confidenceLevel]?.label}
                      </span>
                      {reason.signal && (
                        <span className="text-[11px] text-[var(--text-subtle)]">
                          {reason.signal.label} · detected {reason.signal.detectedRelative} · {Math.round(reason.signal.decay * 100)}% of its value remaining
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
              {lead.reasons.length === 0 && <p className="text-sm text-[var(--text-muted)]">No reasons recorded.</p>}
            </ol>
          </Surface>

          {/* ── Recommended action ─────────────────────────────────────────── */}
          {primaryAction && (
            <Surface className="overflow-hidden">
              <div className="border-b border-[var(--border)] bg-[var(--accent-soft)] px-5 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--accent)]">Recommended next step</p>
                <p className="mt-0.5 text-[15px] font-semibold">{primaryAction.title}</p>
                <p className="mt-1 text-sm text-[var(--text-muted)]">{primaryAction.rationale}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-5 py-3">
                <Button size="sm" onClick={() => setComposerOpen(true)}>
                  <Mail size={13} />{activeThread ? "Open conversation" : "Write & send email"}
                </Button>
                <ThreadStatusChip thread={activeThread} />
                {activeThread && (
                  <span className="text-[11px] text-[var(--text-subtle)]">
                    to {activeThread.recipientEmail}
                    {activeThread.followUpsSent > 0 && ` · ${activeThread.followUpsSent} follow-up${activeThread.followUpsSent > 1 ? "s" : ""}`}
                  </span>
                )}
              </div>

              {outreach && (
                <div className="space-y-3 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-subtle)]">
                      Suggested {outreach.channel.toLowerCase().replace("_", " ")} opener
                    </span>
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", CONFIDENCE_STYLES[outreach.generatedBy === "LLM" ? "AI_GENERATED" : "DETECTED"]?.className)}>
                      {outreach.generatedBy === "LLM" ? "AI-drafted" : "Template"}
                    </span>
                  </div>

                  {outreach.subjectLine && (
                    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
                      <p className="text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">Subject</p>
                      <p className="mt-0.5 text-sm">{outreach.subjectLine}</p>
                    </div>
                  )}
                  <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
                    <p className="text-sm leading-relaxed">{outreach.openingLine}</p>
                  </div>

                  {outreach.talkingPoints?.length > 0 && (
                    <div>
                      <p className="mb-1.5 text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">Talking points</p>
                      <ul className="space-y-1.5">
                        {outreach.talkingPoints.map((tp, i) => (
                          <li key={i} className="flex items-start gap-2 text-[13px] text-[var(--text-muted)]">
                            <Check size={12} className="mt-1 shrink-0 text-[var(--color-positive)]" />
                            <span>{tp.point}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <Button
                    variant="secondary" size="sm"
                    onClick={() => copy([outreach.subjectLine, "", outreach.openingLine, "", ...(outreach.talkingPoints || []).map((t) => `• ${t.point}`)].filter(Boolean).join("\n"), "Outreach draft")}
                  >
                    <Copy size={13} />Copy draft
                  </Button>
                </div>
              )}

              {lead.actions.length > 1 && (
                <div className="border-t border-[var(--border)] px-5 py-3">
                  <p className="mb-1.5 text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">Also consider</p>
                  <ul className="space-y-1">
                    {lead.actions.slice(1).map((a, i) => (
                      <li key={i} className="text-[13px] text-[var(--text-muted)]">
                        <span className="font-medium text-[var(--text)]">{ACTION_LABELS[a.actionType] || a.actionType}</span> — {a.rationale}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Surface>
          )}

          {/* ── Active hiring ──────────────────────────────────────────────── */}
          {lead.jobs.length > 0 && (
            <Surface className="p-5">
              <SectionHeading
                icon={Briefcase}
                title="Hiring activity"
                description={`${lead.jobSummary.active} active · ${lead.jobSummary.recentlyActive} recently active · ${lead.jobSummary.expired} expired. Only board-confirmed roles count towards the score.`}
              />
              <ul className="divide-y divide-[var(--border)]">
                {lead.jobs.slice(0, 12).map((job) => (
                  <li key={job.id} className="py-2.5 first:pt-0">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          {job.url ? (
                            <a href={job.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium hover:text-[var(--accent)] hover:underline">
                              {job.title}
                            </a>
                          ) : <span className="text-sm font-medium">{job.title}</span>}
                          <Badge tone={JOB_STATUS_TONE[job.status]}>{JOB_STATUS_LABELS[job.status]}</Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                          {[job.location, job.department, job.employmentType].filter(Boolean).join(" · ") || "—"}
                        </p>
                        {job.skills.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {job.skills.slice(0, 8).map((s) => <Badge key={s}>{s}</Badge>)}
                          </div>
                        )}
                      </div>
                      <div className="text-right text-[11px] text-[var(--text-subtle)]">
                        {job.postedRelative && <p>Posted {job.postedRelative}</p>}
                        {job.verifiedRelative && <p>Checked {job.verifiedRelative}</p>}
                        <p className="mt-0.5">{job.source.name}</p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              {lead.jobSummary.atsBoards.length > 0 && (
                <p className="mt-3 border-t border-[var(--border)] pt-3 text-xs text-[var(--text-muted)]">
                  Job status verified directly against{" "}
                  {lead.jobSummary.atsBoards.map((b) => (
                    <a key={b.slug} href={b.boardUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] hover:underline">
                      {titleize(b.provider.replace("ATS_", ""))}
                    </a>
                  ))}.
                </p>
              )}
            </Surface>
          )}

          {/* ── Website intelligence ───────────────────────────────────────── */}
          {lead.website && (
            <Surface className="p-5">
              <SectionHeading
                icon={ShieldCheck}
                title="Website audit"
                description={`${lead.website.pagesAudited} page${lead.website.pagesAudited === 1 ? "" : "s"} analysed ${lead.website.auditedRelative}.`}
                actions={
                  <div className="text-right">
                    <p className="tnum text-2xl font-semibold" style={{ color: scoreTone(lead.website.overallScore) }}>
                      {lead.website.overallScore}
                    </p>
                    <p className="text-[10px] uppercase tracking-wide text-[var(--text-subtle)]">out of 100</p>
                  </div>
                }
              />

              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {Object.entries(lead.website.subscores).map(([key, value]) => (
                  <div key={key}>
                    <div className="mb-1 flex items-baseline justify-between">
                      <span className="text-xs capitalize text-[var(--text-muted)]">{key}</span>
                      <span className="tnum text-xs font-medium">{value}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                      <div className="h-full rounded-full" style={{ width: `${value}%`, background: scoreTone(value) }} />
                    </div>
                  </div>
                ))}
              </div>

              <ul className="space-y-2">
                {lead.website.findings.slice(0, 8).map((f, i) => (
                  <li key={i} className="flex items-start gap-2.5">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" style={{ color: SEVERITY_TONE[f.severity] }} />
                    <div className="min-w-0">
                      <p className="text-[13px] leading-snug">{f.detail}</p>
                      {f.evidence && <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--text-subtle)]">{f.evidence}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </Surface>
          )}

          {/* ── Technologies ───────────────────────────────────────────────── */}
          {lead.technologies.length > 0 && (
            <Surface className="p-5">
              <SectionHeading icon={Layers} title="Detected technology" description="Each detection records how it was proven." />
              <div className="grid gap-2 sm:grid-cols-2">
                {lead.technologies.map((t, i) => (
                  <div key={i} className="rounded-lg border border-[var(--border)] p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium">{t.name}{t.version && <span className="ml-1 font-normal text-[var(--text-muted)]">{t.version}</span>}</span>
                      <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", CONFIDENCE_STYLES[t.confidenceLevel]?.className)}>
                        {CONFIDENCE_STYLES[t.confidenceLevel]?.label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">{titleize(t.category)} · matched on {t.matchedOn.toLowerCase().replace("_", " ")}</p>
                  </div>
                ))}
              </div>
            </Surface>
          )}
        </div>

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <div className="space-y-5">
          <Surface className="p-5">
            <SectionHeading icon={Mail} title="Contact" />
            <div className="space-y-2.5">
              {lead.contacts.emails.filter((e) => !e.isSuppressed).map((e, i) => (
                <ContactRow key={i} icon={Mail} value={e.value} hint={e.roleHint} confidence={e.confidenceLevel} onCopy={() => copy(e.value, "Email")} href={`mailto:${e.value}`} />
              ))}
              {lead.contacts.phones.filter((p) => !p.isSuppressed).map((p, i) => (
                <ContactRow key={i} icon={Phone} value={p.value} confidence={p.confidenceLevel} onCopy={() => copy(p.value, "Phone")} href={`tel:${p.value}`} />
              ))}
              {lead.contacts.forms.map((f, i) => (
                <ContactRow key={i} icon={Globe} value="Contact form" confidence={f.confidenceLevel} href={f.value} external />
              ))}
              {lead.contacts.socials.map((s, i) => (
                <ContactRow key={i} icon={ExternalLink} value={titleize(s.roleHint)} confidence={s.confidenceLevel} href={s.value} external />
              ))}
              {lead.contacts.emails.length === 0 && lead.contacts.phones.length === 0 && lead.contacts.forms.length === 0 && (
                <p className="text-sm text-[var(--text-muted)]">No public contact route found yet.</p>
              )}
            </div>
          </Surface>

          <Surface className="p-5">
            <SectionHeading title="Score breakdown" description={`Version ${breakdown.version ?? 1} · scored ${formatDateTime(lead.scoredAt)}`} />
            <div className="space-y-3">
              {Object.entries(categories).map(([key, value]) => (
                <div key={key}>
                  <div className="mb-1 flex items-baseline justify-between text-xs">
                    <span className="capitalize text-[var(--text-muted)]">{key}</span>
                    <span className="tnum font-medium">{value} <span className="text-[var(--text-subtle)]">/ {caps[key]}</span></span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                    <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.min(100, (value / (caps[key] || 100)) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>

            {breakdown.signals?.length > 0 && (
              <div className="mt-4 border-t border-[var(--border)] pt-3">
                <p className="mb-2 text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">Contributing signals</p>
                <ul className="space-y-1.5">
                  {breakdown.signals.slice(0, 8).map((s, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate text-[var(--text-muted)]">{s.label || s.type}</span>
                      <span className="tnum shrink-0 font-medium">
                        {s.points}
                        <span className="ml-1 text-[10px] text-[var(--text-subtle)]">
                          ({s.raw}×{s.strength}×{s.decay})
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Surface>

          <Surface className="p-5">
            <SectionHeading title="Opportunities" />
            <ul className="space-y-2">
              {lead.opportunities.map((o) => (
                <li key={o.service}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[13px] font-medium">{o.label || SERVICE_LABELS[o.service]}</span>
                    <span className="tnum text-xs text-[var(--text-muted)]">{o.points} pts</span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-subtle)]">{o.rationale}</p>
                </li>
              ))}
            </ul>
          </Surface>

          <Surface className="p-5">
            <SectionHeading title="Company record" />
            <dl className="space-y-3">
              <Field label="First seen">{formatDate(lead.company.firstSeenAt)}</Field>
              <Field label="Last crawled">{formatDate(lead.company.lastCrawledAt)}</Field>
              <Field label="Newest evidence">{formatDateTime(lead.freshness.newestEvidenceAt)}</Field>
              {lead.company.locations[0]?.addressLine && <Field label="Address">{lead.company.locations[0].addressLine}</Field>}
              {lead.originQuery && <Field label="Found via search">“{lead.originQuery.rawText}”</Field>}
            </dl>
          </Surface>

          {lead.history.length > 0 && (
            <Surface className="p-5">
              <SectionHeading title="History" />
              <ul className="space-y-2">
                {lead.history.map((h, i) => (
                  <li key={i} className="text-xs">
                    <span className="font-medium">{STATUS_LABELS[h.toStatus] || h.toStatus}</span>
                    <span className="text-[var(--text-subtle)]"> · {formatDateTime(h.changedAt)}</span>
                    {h.note && <p className="mt-0.5 text-[var(--text-muted)]">{h.note}</p>}
                  </li>
                ))}
              </ul>
            </Surface>
          )}
        </div>
      </PageBody>

      <ProvenanceDrawer leadId={id} open={drawerOpen} onClose={() => setDrawerOpen(false)} companyName={lead.company.name} />
      {composerOpen && (
        <EmailComposer
          leadId={id}
          name={lead.company.name}
          contacts={{
            email: lead.contacts.emails.filter((e) => !e.isSuppressed)[0] || null,
            phone: lead.contacts.phones.filter((p) => !p.isSuppressed)[0] || null,
          }}
          onClose={() => setComposerOpen(false)}
        />
      )}
    </div>
  );
}

const ContactRow = ({ icon: Icon, value, hint, confidence, onCopy, href, external }) => (
  <div className="flex items-center gap-2.5">
    <Icon size={14} className="shrink-0 text-[var(--text-subtle)]" />
    <div className="min-w-0 flex-1">
      {href ? (
        <a
          href={href}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="block truncate text-[13px] hover:text-[var(--accent)] hover:underline"
        >
          {value}
        </a>
      ) : <span className="block truncate text-[13px]">{value}</span>}
      <div className="flex items-center gap-1.5">
        {hint && hint !== "PAGE_TEXT" && <span className="text-[10px] text-[var(--text-subtle)]">{titleize(hint)}</span>}
        {confidence && (
          <span className={cn("rounded px-1 py-px text-[9px] font-medium", CONFIDENCE_STYLES[confidence]?.className)}>
            {CONFIDENCE_STYLES[confidence]?.label}
          </span>
        )}
      </div>
    </div>
    {onCopy && (
      <button onClick={onCopy} className="shrink-0 rounded p-1 text-[var(--text-subtle)] hover:bg-[var(--surface-sunken)] hover:text-[var(--text)]" aria-label={`Copy ${value}`}>
        <Copy size={12} />
      </button>
    )}
  </div>
);
