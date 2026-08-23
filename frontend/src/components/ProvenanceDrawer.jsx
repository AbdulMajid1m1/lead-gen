import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, Database, Globe, Briefcase, Layers, FileSearch, ShieldAlert, ChevronRight } from "lucide-react";
import { api } from "../lib/api.js";
import { Badge, ErrorState, Skeleton } from "./ui.jsx";
import { CONFIDENCE_STYLES, formatDateTime, titleize, cn } from "../lib/format.js";

const EVIDENCE_ICON = {
  EXTRACTED_FACT: FileSearch,
  JOB_POSTING: Briefcase,
  TECHNOLOGY: Layers,
  WEBSITE_AUDIT: ShieldAlert,
  SOURCE_RECORD: Database,
  NOTE: FileSearch,
};

/**
 * The full answer to "where did this lead come from?".
 *
 * Reads top-down as the pipeline actually ran: discovery run → pages fetched
 * (including the ones that were refused, and why) → each signal with the
 * evidence and original source behind it.
 */
export const ProvenanceDrawer = ({ leadId, open, onClose, companyName }) => {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["provenance", leadId],
    queryFn: () => api.getProvenance(leadId),
    enabled: open,
  });

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[3px]" onClick={onClose} aria-hidden />

      <aside
        role="dialog"
        aria-label="Data provenance"
        className="relative flex h-full w-full max-w-xl flex-col border-l border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--shadow-lg)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Data provenance</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              Every claim about {companyName}, traced back to where it came from.
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--surface-sunken)]" aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isPending && <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>}
          {isError && <ErrorState error={error} onRetry={refetch} />}

          {data && (
            <div className="space-y-6">
              {/* Discovery */}
              {data.discovery && (
                <section>
                  <SectionLabel>1 · How it was discovered</SectionLabel>
                  <div className="rounded-lg border border-[var(--border)] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium">{titleize(data.discovery.trigger)} discovery run</span>
                      <Badge>{titleize(data.discovery.status)}</Badge>
                    </div>
                    <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">Started {formatDateTime(data.discovery.startedAt)}</p>
                    <ol className="mt-2 space-y-1">
                      {data.discovery.steps.map((s) => (
                        <li key={s.ordinal} className="flex items-start gap-2 text-[11px] text-[var(--text-muted)]">
                          <ChevronRight size={11} className="mt-0.5 shrink-0" />
                          <span>{s.label} <span className="text-[var(--text-subtle)]">({s.status.toLowerCase()})</span></span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </section>
              )}

              {/* Crawls — including refusals, which are provenance too */}
              {data.crawls.length > 0 && (
                <section>
                  <SectionLabel>{data.discovery ? "2" : "1"} · Pages fetched</SectionLabel>
                  <ul className="space-y-1.5">
                    {data.crawls.map((c, i) => (
                      <li key={i} className="rounded-lg border border-[var(--border)] px-3 py-2">
                        <div className="flex items-start justify-between gap-2">
                          <span className="min-w-0 truncate font-mono text-[11px]">{c.url}</span>
                          <Badge tone={c.blockReason ? "var(--color-critical)" : "var(--color-positive)"}>
                            {c.blockReason || `HTTP ${c.httpStatus ?? "—"}`}
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-[10px] text-[var(--text-subtle)]">
                          robots.txt: {c.robotsDecision?.toLowerCase() || "unknown"}
                          {c.totalMs != null && ` · ${c.totalMs}ms`}
                          {c.bytes != null && ` · ${Math.round(c.bytes / 1024)}KB`}
                          {c.fetchedAt && ` · ${formatDateTime(c.fetchedAt)}`}
                        </p>
                        {c.blockDetail && <p className="mt-0.5 text-[10px] text-[var(--color-critical)]">{c.blockDetail}</p>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Signals + evidence */}
              <section>
                <SectionLabel>{(data.discovery ? 1 : 0) + (data.crawls.length ? 1 : 0) + 1} · Signals and their evidence</SectionLabel>
                <div className="space-y-3">
                  {data.chains.map((chain) => (
                    <div key={chain.signal.id} className="rounded-lg border border-[var(--border)]">
                      <div className="border-b border-[var(--border)] bg-[var(--surface-sunken)] px-3 py-2">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[13px] font-medium">{chain.signal.label}</span>
                          <span className="tnum shrink-0 text-xs font-semibold text-[var(--accent)]">+{chain.signal.points}</span>
                        </div>
                        <p className="mt-0.5 text-[10px] text-[var(--text-subtle)]">
                          weight {chain.signal.weight} × strength {chain.signal.strength} × freshness {chain.signal.decay}
                          {" · "}detected {chain.signal.detectedRelative}
                        </p>
                        {chain.reason && (
                          <p className="mt-1.5 text-[12px] leading-snug text-[var(--text-muted)]">
                            “{chain.reason.text}”
                            <span className={cn("ml-1.5 rounded px-1 py-px text-[9px] font-medium", CONFIDENCE_STYLES[chain.reason.confidenceLevel]?.className)}>
                              {CONFIDENCE_STYLES[chain.reason.confidenceLevel]?.label}
                            </span>
                          </p>
                        )}
                      </div>

                      <ul className="divide-y divide-[var(--border)]">
                        {chain.evidence.map((ev, i) => <EvidenceRow key={i} evidence={ev} />)}
                        {chain.evidence.length === 0 && (
                          <li className="px-3 py-2 text-[11px] text-[var(--text-subtle)]">No evidence rows recorded.</li>
                        )}
                      </ul>
                    </div>
                  ))}
                  {data.chains.length === 0 && <p className="text-sm text-[var(--text-muted)]">No active signals.</p>}
                </div>
              </section>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
};

const SectionLabel = ({ children }) => (
  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">{children}</h3>
);

const EvidenceRow = ({ evidence }) => {
  const Icon = EVIDENCE_ICON[evidence.kind] || FileSearch;
  return (
    <li className="flex gap-2.5 px-3 py-2.5">
      <Icon size={13} className="mt-0.5 shrink-0 text-[var(--text-subtle)]" />
      <div className="min-w-0 flex-1 space-y-1">
        {evidence.fact && (
          <>
            <p className="text-[12px]">
              <span className="font-mono text-[11px] text-[var(--text-muted)]">{evidence.fact.key}</span>
              {evidence.fact.value && <> = <span className="font-medium">{String(evidence.fact.value).slice(0, 120)}</span></>}
            </p>
            {evidence.fact.snippet && (
              <p className="rounded bg-[var(--surface-sunken)] px-2 py-1 text-[11px] italic text-[var(--text-muted)]">{evidence.fact.snippet}</p>
            )}
            <Meta>
              extracted by {evidence.fact.extractor} · {formatDateTime(evidence.fact.extractedAt)}
              <span className={cn("ml-1.5 rounded px-1 py-px text-[9px] font-medium", CONFIDENCE_STYLES[evidence.fact.confidenceLevel]?.className)}>
                {CONFIDENCE_STYLES[evidence.fact.confidenceLevel]?.label}
              </span>
            </Meta>
          </>
        )}

        {evidence.job && (
          <>
            <p className="text-[12px] font-medium">{evidence.job.title}</p>
            <Meta>
              status {evidence.job.status.toLowerCase().replace("_", " ")}
              {evidence.job.postedAt && ` · posted ${formatDateTime(evidence.job.postedAt)}`}
              {evidence.job.lastVerifiedAt && ` · re-checked ${formatDateTime(evidence.job.lastVerifiedAt)}`}
            </Meta>
            {Array.isArray(evidence.job.statusEvidence) && evidence.job.statusEvidence.length > 0 && (
              <p className="rounded bg-[var(--surface-sunken)] px-2 py-1 font-mono text-[10px] text-[var(--text-muted)]">
                {(() => {
                  const last = evidence.job.statusEvidence[evidence.job.statusEvidence.length - 1];
                  return `${last.method}: ${last.boardHadJob === true ? "present on board" : last.boardHadJob === false ? "absent from board" : last.note || "—"} → ${last.decidedStatus}`;
                })()}
              </p>
            )}
            {evidence.job.url && <ExternalRef href={evidence.job.url} label="View the posting" />}
          </>
        )}

        {evidence.technology && (
          <>
            <p className="text-[12px]">
              <span className="font-medium">{evidence.technology.name}</span>
              {evidence.technology.version && ` ${evidence.technology.version}`}
              <span className={cn("ml-1.5 rounded px-1 py-px text-[9px] font-medium", CONFIDENCE_STYLES[evidence.technology.confidenceLevel]?.className)}>
                {CONFIDENCE_STYLES[evidence.technology.confidenceLevel]?.label}
              </span>
            </p>
            {evidence.technology.evidence && (
              <p className="rounded bg-[var(--surface-sunken)] px-2 py-1 font-mono text-[10px] break-all text-[var(--text-muted)]">
                {evidence.technology.evidence}
              </p>
            )}
          </>
        )}

        {evidence.audit && (
          <>
            <p className="text-[12px]">Website audit scored <span className="font-medium">{evidence.audit.overallScore}/100</span> across {evidence.audit.pagesAudited} page(s)</p>
            <p className="rounded bg-[var(--surface-sunken)] px-2 py-1 text-[11px] text-[var(--text-muted)]">
              {(evidence.audit.findings || []).slice(0, 3).map((f) => f.detail).join(" ")}
            </p>
            <Meta>audited {formatDateTime(evidence.audit.auditedAt)}</Meta>
          </>
        )}

        {evidence.note && !evidence.fact && !evidence.job && !evidence.technology && !evidence.audit && (
          <p className="text-[12px] text-[var(--text-muted)]">{evidence.note}</p>
        )}

        {evidence.source && (
          <div className="mt-1 rounded border border-dashed border-[var(--border)] px-2 py-1.5">
            <p className="flex items-center gap-1.5 text-[10px] font-medium text-[var(--text-muted)]">
              <Database size={10} />Source: {evidence.source.sourceName}
            </p>
            <p className="mt-0.5 text-[10px] text-[var(--text-subtle)]">
              fetched {evidence.source.fetchedRelative}
              {evidence.source.payloadHash && ` · payload sha256 ${evidence.source.payloadHash.slice(0, 12)}…`}
            </p>
            {evidence.source.url && <ExternalRef href={evidence.source.url} label="Open the original record" />}
            {evidence.source.attribution && (
              <p className="mt-0.5 text-[9px] italic text-[var(--text-subtle)]">{evidence.source.attribution}</p>
            )}
          </div>
        )}

        {evidence.crawl && (
          <Meta>
            <Globe size={9} className="mr-1 inline" />
            fetched {evidence.crawl.finalUrl || evidence.crawl.url} · HTTP {evidence.crawl.httpStatus} · robots {evidence.crawl.robotsDecision?.toLowerCase()}
          </Meta>
        )}
      </div>
    </li>
  );
};

const Meta = ({ children }) => <p className="text-[10px] text-[var(--text-subtle)]">{children}</p>;

const ExternalRef = ({ href, label }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-block text-[10px] text-[var(--accent)] hover:underline">
    {label} ↗
  </a>
);
