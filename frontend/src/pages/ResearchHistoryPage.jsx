import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { History, ArrowRight, Wallet, Sparkles } from "lucide-react";
import { PageBody, PageHeader } from "../App.jsx";
import { api } from "../lib/api.js";
import { Badge, EmptyState, ErrorState, Skeleton, Surface } from "../components/ui.jsx";
import { formatDateTime, titleize } from "../lib/format.js";

const STATUS_TONE = {
  SUCCEEDED: "var(--color-positive)",
  PARTIAL: "var(--color-caution)",
  FAILED: "var(--color-critical)",
  RUNNING: "var(--accent)",
};

/**
 * Every past research run, with the results frozen as they were.
 *
 * Leads keep changing underneath — re-scored every few hours, re-crawled
 * nightly — so a run opened next week would otherwise show different numbers
 * than the ones the user acted on. The snapshot is what makes this trustworthy.
 */
export default function ResearchHistoryPage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["research-history"],
    queryFn: () => api.getResearchHistory({ pageSize: 30 }),
  });

  return (
    <div>
      <PageHeader
        title="Research history"
        description="Every search you have run, with its results saved exactly as they were found."
      />

      <PageBody className="space-y-3">
        {isPending && Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
        {isError && <ErrorState error={error} onRetry={refetch} />}

        {data?.runs?.length === 0 && (
          <Surface className="border-dashed">
            <EmptyState icon={History} title="No research yet"
              description="Runs you start from the Deep research page are saved here with their full results." />
          </Surface>
        )}

        {data?.runs?.map((run) => (
          <Surface key={run.runId} className="transition-colors hover:border-[var(--border-strong)]">
            <Link to={`/research?run=${run.runId}`} className="block p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{run.query || "Untitled research"}</p>
                  {run.goal && <p className="mt-0.5 line-clamp-2 text-xs text-[var(--text-muted)]">{run.goal}</p>}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-subtle)]">
                    <span>{formatDateTime(run.createdAt)}</span>
                    {run.briefProducedBy === "LLM" && (
                      <span className="inline-flex items-center gap-1"><Sparkles size={9} />AI-planned</span>
                    )}
                    {run.aiUsage?.estCostUsd > 0 && (
                      <span className="inline-flex items-center gap-1">
                        <Wallet size={9} />${run.aiUsage.estCostUsd.toFixed(3)} · {run.aiUsage.searchCalls} web searches
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {run.resultCount > 0 && <Badge tone="var(--color-positive)">{run.resultCount} results</Badge>}
                  {run.candidateCount > 0 && <Badge>{run.candidateCount} AI candidates</Badge>}
                  <Badge tone={STATUS_TONE[run.status]}>{titleize(run.status)}</Badge>
                  <ArrowRight size={13} className="text-[var(--text-subtle)]" />
                </div>
              </div>
            </Link>
          </Surface>
        ))}
      </PageBody>
    </div>
  );
}
