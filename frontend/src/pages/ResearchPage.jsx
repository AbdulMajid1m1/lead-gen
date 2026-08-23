import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Sparkles, Search, CornerDownLeft, X, ExternalLink, Mail,
  AlertTriangle, History, Wallet, ChevronDown, ChevronRight, PenLine,
} from "lucide-react";
import { toast } from "sonner";
import { PageBody } from "../App.jsx";
import { api, subscribeToRun } from "../lib/api.js";
import { Button, EmptyState, ErrorState, Skeleton, Spinner, Surface } from "../components/ui.jsx";
import { ConfidenceCell, ConfidenceLegend } from "../components/ConfidenceCell.jsx";
import { DiscoveryProgress } from "../components/DiscoveryProgress.jsx";
import EmailComposer, { ThreadStatusChip } from "../components/EmailComposer.jsx";
import { scoreTone } from "../lib/format.js";

const EXAMPLES = [
  "businesses that need a new website in Saudi Arabia related to POS",
  "retail shops in Riyadh that need a new website",
  "restaurants in Dubai with no online ordering",
];

export default function ResearchPage() {
  const [params, setParams] = useSearchParams();
  const runId = params.get("run");
  const [input, setInput] = useState("");
  const [emailFor, setEmailFor] = useState(null);
  const [showUnverified, setShowUnverified] = useState(false);
  const inputRef = useRef(null);
  const queryClient = useQueryClient();

  useEffect(() => { if (!runId) inputRef.current?.focus(); }, [runId]);

  const start = useMutation({
    mutationFn: (q) => api.startResearch({ q }),
    onSuccess: (data) => {
      setParams({ run: data.runId });
      if (!data.aiAvailable) {
        toast.warning("AI search is unavailable — running the map and crawler engines only.");
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const { data: grid, isPending, isError, error, refetch } = useQuery({
    queryKey: ["research-grid", runId],
    queryFn: () => api.getResearchGrid(runId),
    enabled: Boolean(runId),
    refetchInterval: (q) => (["PENDING", "RUNNING"].includes(q.state.data?.status) ? 10_000 : false),
  });

  // One slim fetch maps leadId → outreach thread, for the status chips.
  const { data: threadsData } = useQuery({ queryKey: ["outreach-threads"], queryFn: () => api.listThreads() });
  const threadByLead = new Map((threadsData?.threads || []).map((t) => [t.leadId, t]));

  const draftAll = useMutation({
    mutationFn: () => api.composeBatch({
      leadIds: grid.rows.map((r) => r.leadId).slice(0, 50),
      runId,
    }),
    onSuccess: (data) => {
      toast.success(`${data.written} emails drafted — ${data.aiWritten} by AI, ${data.templated} from templates.`);
      queryClient.invalidateQueries({ queryKey: ["research-grid", runId] });
      queryClient.invalidateQueries({ queryKey: ["email-drafts"] });
    },
    onError: (err) => toast.error(err.message),
  });

  // Refresh the grid as the run progresses so rows appear while you watch.
  useEffect(() => {
    if (!runId) return undefined;
    const unsubscribe = subscribeToRun(runId, (event) => {
      if (["step.finished", "run.finished"].includes(event.type)) {
        queryClient.invalidateQueries({ queryKey: ["research-grid", runId] });
      }
    }, () => {});
    return unsubscribe;
  }, [runId, queryClient]);

  const submit = (e) => {
    e?.preventDefault();
    const q = input.trim();
    if (q.length < 3) return;
    start.mutate(q);
  };

  const isRunning = ["PENDING", "RUNNING"].includes(grid?.status);

  return (
    <div>
      {/* ── Query bar ─────────────────────────────────────────────────────── */}
      <div className="border-b border-[var(--border)] bg-[var(--surface-raised)]">
        <div className="mx-auto max-w-5xl px-5 py-8 md:px-8">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-[var(--accent)]" />
              <h1 className="text-lg font-semibold tracking-tight">Deep research</h1>
            </div>
            <Link to="/research/history">
              <Button variant="secondary" size="sm"><History size={13} />History</Button>
            </Link>
          </div>

          <form onSubmit={submit}>
            <div className="relative">
              <Search size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-subtle)]" />
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="businesses that need a new website in Saudi Arabia related to POS"
                aria-label="Describe the customers you want to find"
                className="w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)] py-3.5 pl-11 pr-32 text-[15px] outline-none transition-colors placeholder:text-[var(--text-subtle)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)] shadow-[var(--shadow-xs)]"
              />
              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                {input && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setInput("")} aria-label="Clear"><X size={14} /></Button>
                )}
                <Button type="submit" size="sm" disabled={start.isPending || input.trim().length < 3}>
                  {start.isPending ? "Starting…" : <>Research <CornerDownLeft size={12} /></>}
                </Button>
              </div>
            </div>
          </form>

          {!runId && (
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((ex) => (
                <button key={ex} onClick={() => { setInput(ex); inputRef.current?.focus(); }}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]">
                  {ex}
                </button>
              ))}
            </div>
          )}

          {grid?.brief && (
            <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Research plan</p>
              <p className="mt-1 text-sm">{grid.brief.restatedGoal}</p>
              {grid.brief.exclusions?.length > 0 && (
                <p className="mt-1.5 text-xs text-[var(--text-muted)]">
                  <span className="font-medium">Deliberately excluded:</span> {grid.brief.exclusions.join("; ")}
                </p>
              )}
              {grid.aiUsage && (
                <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-[var(--text-subtle)]">
                  <Wallet size={10} />
                  {grid.aiUsage.calls} AI calls · {grid.aiUsage.searchCalls} web searches · ${grid.aiUsage.estCostUsd?.toFixed(3)}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <PageBody className="space-y-4">
        {runId && isRunning && <DiscoveryProgress runId={runId} onFinished={() => refetch()} />}
        {isPending && runId && <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>}
        {isError && <ErrorState error={error} onRetry={refetch} />}

        {!runId && !start.isPending && (
          <Surface className="border-dashed">
            <EmptyState
              icon={Sparkles}
              title="Describe the customer you want"
              description="AI web search and our own map and crawler engines run together. Every contact detail the AI claims is checked against a real page before it is shown as confirmed."
            />
          </Surface>
        )}

        {grid?.rows?.length > 0 && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-[var(--text-muted)]">
                <span className="font-semibold text-[var(--text)]">{grid.rows.length}</span> matches
                {grid.isSnapshot && <span className="ml-2 text-xs">· saved to history</span>}
              </p>
              <div className="flex items-center gap-3">
                <Button variant="secondary" size="sm" onClick={() => draftAll.mutate()} disabled={draftAll.isPending || isRunning}>
                  {draftAll.isPending ? <Spinner size={12} /> : <PenLine size={12} />}
                  {draftAll.isPending ? "Drafting…" : "Draft all emails"}
                </Button>
                <ConfidenceLegend />
              </div>
            </div>

            <Surface className="overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1460px] text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-[var(--border)] bg-[var(--surface-sunken)] text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">
                      <th className="px-3 py-2.5 font-medium">#</th>
                      <th className="px-3 py-2.5 font-medium">Score</th>
                      <th className="px-3 py-2.5 font-medium">Company</th>
                      <th className="px-3 py-2.5 font-medium">Website</th>
                      <th className="w-[300px] px-3 py-2.5 font-medium">About</th>
                      <th className="px-3 py-2.5 font-medium">Email</th>
                      <th className="px-3 py-2.5 font-medium">Phone</th>
                      <th className="px-3 py-2.5 font-medium">WhatsApp</th>
                      <th className="px-3 py-2.5 font-medium">Address</th>
                      <th className="w-[280px] px-3 py-2.5 font-medium">Why</th>
                      <th className="px-3 py-2.5 font-medium">Outreach</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {grid.rows.map((row) => (
                      <tr key={row.leadId} className="align-top transition-colors hover:bg-[var(--surface-sunken)]">
                        <td className="tnum px-3 py-3 text-[var(--text-subtle)]">{row.rank}</td>
                        <td className="px-3 py-3">
                          <span className="tnum font-semibold" style={{ color: scoreTone(row.score) }}>{row.score}</span>
                        </td>
                        <td className="max-w-[190px] px-3 py-3">
                          <Link to={`/leads/${row.leadId}`} className="block truncate font-medium hover:text-[var(--accent)] hover:underline">
                            {row.name}
                          </Link>
                          <p className="truncate text-[11px] text-[var(--text-subtle)]">
                            {[row.industry, row.city].filter(Boolean).join(" · ")}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {row.foundBy.map((f) => (
                              <span key={f} className="rounded bg-[var(--surface-sunken)] px-1 py-px text-[9px] text-[var(--text-subtle)]">
                                {f === "AI_WEB_SEARCH" ? "AI" : f === "OVERPASS" ? "map" : "crawl"}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="max-w-[150px] px-3 py-3">
                          {row.website?.url ? (
                            <a href={row.website.url} target="_blank" rel="noopener noreferrer"
                               className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-[12px] text-[var(--accent)] hover:underline">
                              <span className="truncate">{row.website.domain}</span><ExternalLink size={9} className="shrink-0" />
                            </a>
                          ) : row.website?.absent ? (
                            <span className="text-[var(--color-caution)]" title="A source established this business has no website — that is the opportunity.">no website</span>
                          ) : (
                            <span className="text-[var(--text-subtle)]" title="No website found yet — it has not been verified as absent.">not checked</span>
                          )}
                        </td>
                        <td className="w-[300px] min-w-[300px] px-3 py-3">
                          {row.about ? (
                            <span className="line-clamp-3 text-[12px] text-[var(--text-muted)]" title={row.about.text}>{row.about.text}</span>
                          ) : <span className="text-[var(--text-subtle)]">—</span>}
                        </td>
                        <td className="max-w-[180px] px-3 py-3">
                          <ConfidenceCell cell={row.contacts.email} mono href={row.contacts.email ? `mailto:${row.contacts.email.value}` : null} />
                        </td>
                        <td className="max-w-[140px] px-3 py-3">
                          <ConfidenceCell cell={row.contacts.phone} mono href={row.contacts.phone ? `tel:${row.contacts.phone.value}` : null} />
                        </td>
                        <td className="max-w-[140px] px-3 py-3">
                          <ConfidenceCell cell={row.contacts.whatsapp} mono
                            href={row.contacts.whatsapp ? `https://wa.me/${String(row.contacts.whatsapp.value).replace(/\D/g, "")}` : null} />
                        </td>
                        <td className="max-w-[180px] px-3 py-3"><ConfidenceCell cell={row.address} /></td>
                        <td className="w-[280px] min-w-[280px] px-3 py-3">
                          <ul className="space-y-0.5">
                            {row.why.slice(0, 2).map((w, i) => (
                              <li key={i} className="line-clamp-2 text-[12px] text-[var(--text-muted)]">{w.text}</li>
                            ))}
                          </ul>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-col items-start gap-1">
                            <Button variant="secondary" size="sm" onClick={() => setEmailFor(row)}>
                              <Mail size={12} />Email
                            </Button>
                            <ThreadStatusChip thread={threadByLead.get(row.leadId)} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Surface>
          </>
        )}

        {/* Candidates the AI mentioned but we could not confirm — visible, never mixed in. */}
        {grid?.unverified?.length > 0 && (
          <Surface className="border-[color-mix(in_oklch,var(--color-caution)_40%,transparent)]">
            <button onClick={() => setShowUnverified((v) => !v)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm">
              {showUnverified ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <AlertTriangle size={14} className="text-[var(--color-caution)]" />
              <span className="font-medium">{grid.unverified.length} unconfirmed candidates</span>
              <span className="text-[var(--text-muted)]">— the AI mentioned these but we could not verify they exist</span>
            </button>
            {showUnverified && (
              <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
                {grid.unverified.map((c, i) => (
                  <li key={i} className="px-4 py-2.5">
                    <p className="text-[13px] font-medium">{c.name}</p>
                    <p className="text-[11px] text-[var(--text-muted)]">{c.reason}</p>
                  </li>
                ))}
              </ul>
            )}
          </Surface>
        )}

        {grid && !isRunning && grid.rows.length === 0 && (
          <Surface className="border-dashed">
            <EmptyState icon={Search} title="No confirmed matches"
              description="The run finished but nothing passed verification. Check the step results above — the AI search may have been unavailable, or the area may have thin coverage." />
          </Surface>
        )}
      </PageBody>

      {emailFor && (
        <EmailComposer
          leadId={emailFor.leadId}
          name={emailFor.name}
          contacts={emailFor.contacts}
          address={emailFor.address}
          onClose={() => setEmailFor(null)}
        />
      )}
    </div>
  );
}
