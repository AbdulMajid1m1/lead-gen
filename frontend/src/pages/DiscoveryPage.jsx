import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radar, Play } from "lucide-react";
import { toast } from "sonner";
import { PageBody, PageHeader } from "../App.jsx";
import { api } from "../lib/api.js";
import { Badge, Button, EmptyState, ErrorState, Skeleton, Surface, SectionHeading } from "../components/ui.jsx";
import { DiscoveryProgress } from "../components/DiscoveryProgress.jsx";
import { formatDateTime, titleize } from "../lib/format.js";

const RUN_TONE = {
  SUCCEEDED: "var(--color-positive)",
  PARTIAL: "var(--color-caution)",
  FAILED: "var(--color-critical)",
  RUNNING: "var(--accent)",
  PENDING: "var(--color-ink-400)",
  CANCELLED: "var(--color-ink-400)",
};

export default function DiscoveryPage() {
  const [activeRunId, setActiveRunId] = useState(null);
  const [form, setForm] = useState({ location: "", categories: [], radiusMeters: 10000, limit: 120, crawl: true });
  const queryClient = useQueryClient();

  const { data: categoryData } = useQuery({ queryKey: ["categories"], queryFn: api.listCategories, staleTime: Infinity });
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["runs"],
    queryFn: api.listRuns,
    refetchInterval: activeRunId ? false : 15_000,
  });

  const start = useMutation({
    mutationFn: () => api.startRun(form),
    onSuccess: (d) => {
      setActiveRunId(d.discoveryRunId);
      toast.success("Discovery started.");
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const toggleCategory = (key) =>
    setForm((f) => ({
      ...f,
      categories: f.categories.includes(key)
        ? f.categories.filter((c) => c !== key)
        : f.categories.length >= 3 ? f.categories : [...f.categories, key],
    }));

  return (
    <div>
      <PageHeader
        title="Discovery runs"
        description="Target a place and an industry directly, or review what previous runs found."
      />

      <PageBody className="space-y-5">
        <Surface className="p-5">
          <SectionHeading
            icon={Radar}
            title="Run a targeted discovery"
            description="Searches OpenStreetMap business records for the area, then crawls and audits the websites it finds."
          />

          <div className="grid gap-4 md:grid-cols-[1fr_auto]">
            <div className="space-y-4">
              <label className="block">
                <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Location</span>
                <input
                  value={form.location}
                  onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                  placeholder="e.g. Manchester, United Kingdom"
                  className="mt-1 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-2 text-sm outline-none transition-colors placeholder:text-[var(--text-subtle)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)] shadow-[var(--shadow-xs)]"
                />
              </label>

              <div>
                <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
                  Industries <span className="normal-case text-[var(--text-subtle)]">(up to 3)</span>
                </span>
                <div className="mt-1.5 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                  {(categoryData?.categories || []).map((c) => {
                    const selected = form.categories.includes(c.key);
                    return (
                      <button
                        key={c.key}
                        onClick={() => toggleCategory(c.key)}
                        className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                          selected
                            ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                            : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                        }`}
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-wrap items-end gap-4">
                <label className="block">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Radius</span>
                  <select
                    value={form.radiusMeters}
                    onChange={(e) => setForm((f) => ({ ...f, radiusMeters: Number(e.target.value) }))}
                    className="mt-1 block rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)] shadow-[var(--shadow-xs)]"
                  >
                    {[3000, 5000, 10000, 20000, 35000].map((m) => <option key={m} value={m}>{m / 1000} km</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-2 pb-1.5 text-[13px]">
                  <input
                    type="checkbox"
                    checked={form.crawl}
                    onChange={(e) => setForm((f) => ({ ...f, crawl: e.target.checked }))}
                    className="size-4 accent-[var(--accent)]"
                  />
                  Crawl and audit their websites
                </label>
              </div>
            </div>

            <div className="flex items-end">
              <Button
                size="lg"
                disabled={start.isPending || form.location.trim().length < 2 || form.categories.length === 0}
                onClick={() => start.mutate()}
              >
                <Play size={14} />{start.isPending ? "Starting…" : "Start discovery"}
              </Button>
            </div>
          </div>
        </Surface>

        {activeRunId && (
          <DiscoveryProgress
            runId={activeRunId}
            onFinished={() => { queryClient.invalidateQueries(); }}
          />
        )}

        <div>
          <SectionHeading title="Run history" />
          {isPending && <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>}
          {isError && <ErrorState error={error} onRetry={refetch} />}

          {data && data.runs.length === 0 && (
            <Surface className="border-dashed">
              <EmptyState icon={Radar} title="No discovery runs yet" description="Start one above, or search on the Find leads page." />
            </Surface>
          )}

          <div className="space-y-2">
            {data?.runs.map((run) => (
              <Surface key={run.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium">{run.query || `${titleize(run.trigger)} run`}</p>
                    <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">
                      {formatDateTime(run.createdAt)} · {run.steps.length} steps
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {run.stats?.companiesFound > 0 && <Badge>{run.stats.companiesFound} companies</Badge>}
                    {run.stats?.crawled > 0 && <Badge>{run.stats.crawled} crawled</Badge>}
                    {run.stats?.jobsFound > 0 && <Badge>{run.stats.jobsFound} jobs</Badge>}
                    {run.stats?.leadsCreated > 0 && <Badge tone="var(--color-positive)">{run.stats.leadsCreated} leads</Badge>}
                    <Badge tone={RUN_TONE[run.status]}>{titleize(run.status)}</Badge>
                    {["RUNNING", "PENDING"].includes(run.status) && (
                      <Button variant="ghost" size="sm" onClick={() => setActiveRunId(run.id)}>Watch</Button>
                    )}
                  </div>
                </div>
              </Surface>
            ))}
          </div>
        </div>
      </PageBody>
    </div>
  );
}
