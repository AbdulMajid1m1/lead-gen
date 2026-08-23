import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, Sparkles, Radar, X, CornerDownLeft, Info } from "lucide-react";
import { toast } from "sonner";
import { PageBody } from "../App.jsx";
import { api } from "../lib/api.js";
import { Button, EmptyState, ErrorState, SkeletonCard, Surface, Badge } from "../components/ui.jsx";
import { LeadCard } from "../components/LeadCard.jsx";
import { DiscoveryProgress } from "../components/DiscoveryProgress.jsx";
import { cn } from "../lib/format.js";

const EXAMPLES = [
  "restaurants in Dubai with outdated websites",
  "companies hiring CRM specialists this month",
  "dental clinics in London without online booking",
  "e-commerce stores on WooCommerce that need a mobile app",
];

const CHIP_TONE = {
  INDUSTRY: "var(--color-info)",
  LOCATION: "var(--accent)",
  SIGNAL: "var(--color-caution)",
  HIRING: "var(--color-positive)",
  TECH: "var(--color-info)",
  TECH_EXCLUDE: "var(--color-critical)",
  SERVICE: "var(--accent)",
  TIMEFRAME: "var(--color-positive)",
  SIZE: "var(--color-ink-400)",
  SCORE: "var(--color-ink-400)",
};

export default function SearchPage() {
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [runId, setRunId] = useState(null);
  const inputRef = useRef(null);
  const queryClient = useQueryClient();

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Live interpretation preview: the user sees how the query is being read
  // *before* committing to it, which makes the whole thing feel legible.
  useEffect(() => {
    if (input.trim().length < 3) { setPreview(null); return undefined; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.parsePreview(input, controller.signal)
        .then(setPreview)
        .catch(() => {});
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [input]);

  const search = useMutation({
    mutationFn: (q) => api.search({ q, pageSize: 25 }),
    onSuccess: (data) => {
      setResult(data);
      setRunId(data.discoveryRunId || null);
      if (data.discoveryRunId) {
        toast.info("No matches stored yet — searching public sources now.");
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const submit = (e) => {
    e?.preventDefault();
    const q = input.trim();
    if (q.length < 2) return;
    setResult(null);
    setRunId(null);
    search.mutate(q);
  };

  // When a discovery run finishes, re-run the same query so the newly found
  // leads appear without the user having to do anything.
  const onRunFinished = useCallback(
    (status) => {
      queryClient.invalidateQueries();
      api.search({ q: result?.query?.raw || input, pageSize: 25, autoDiscover: false })
        .then((data) => {
          setResult((prev) => ({ ...data, query: prev?.query || data.query }));
          if (data.total > 0) toast.success(`Discovery ${status.toLowerCase()} — ${data.total} lead${data.total === 1 ? "" : "s"} found.`);
          else toast.warning("Discovery finished but produced no qualifying leads for that query.");
        })
        .catch(() => {});
    },
    [input, result?.query?.raw, queryClient],
  );

  const chips = result?.query?.chips || preview?.chips || [];
  const interpretation = result?.query?.interpretation || preview?.interpretation;

  return (
    <div>
      <div className="border-b border-[var(--border)] bg-[var(--surface-raised)]">
        <div className="mx-auto max-w-4xl px-5 py-10 md:px-8 md:py-14">
          <h1 className="text-center text-2xl font-semibold tracking-tight md:text-3xl">
            Describe the customer you want
          </h1>
          <p className="mx-auto mt-2 max-w-xl text-center text-sm leading-relaxed text-[var(--text-muted)]">
            Ask in plain language. LeadSignal searches public business records, company
            websites and live job boards, then explains why each result is worth contacting.
          </p>

          <form onSubmit={submit} className="mt-7">
            <div className="relative">
              <Search size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-subtle)]" />
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="restaurants in Dubai with outdated websites"
                aria-label="Describe the leads you are looking for"
                className="w-full rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)] py-3.5 pl-11 pr-28 text-[15px] outline-none transition-colors placeholder:text-[var(--text-subtle)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)] shadow-[var(--shadow-xs)]"
              />
              <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                {input && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setInput(""); setPreview(null); }} aria-label="Clear">
                    <X size={14} />
                  </Button>
                )}
                <Button type="submit" size="sm" disabled={search.isPending || input.trim().length < 2}>
                  {search.isPending ? "Searching…" : <>Search <CornerDownLeft size={12} /></>}
                </Button>
              </div>
            </div>
          </form>

          {chips.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
              <span className="text-xs text-[var(--text-subtle)]">Understood as:</span>
              {chips.map((chip, i) => (
                <Badge key={i} tone={CHIP_TONE[chip.kind]}>
                  {chip.label}
                  {chip.viaAi && <Sparkles size={9} />}
                </Badge>
              ))}
            </div>
          )}
          {interpretation && !result && (
            <p className="mt-2 text-center text-xs italic text-[var(--text-subtle)]">{interpretation}</p>
          )}

          {!result && !search.isPending && (
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => { setInput(ex); inputRef.current?.focus(); }}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                >
                  {ex}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <PageBody className="space-y-4">
        {runId && <DiscoveryProgress runId={runId} onFinished={onRunFinished} />}

        {search.isPending && (
          <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}</div>
        )}

        {search.isError && <ErrorState error={search.error} onRetry={submit} />}

        {result && !search.isPending && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-[var(--text-muted)]">
                <span className="font-semibold text-[var(--text)]">{result.total}</span>{" "}
                {result.total === 1 ? "lead" : "leads"} matched
                {result.query?.interpretation && <> · <span className="italic">{result.query.interpretation}</span></>}
              </p>
              {result.query?.id && !runId && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    api.discoverForQuery(result.query.id)
                      .then((d) => { setRunId(d.discoveryRunId); toast.info("Searching public sources for more leads."); })
                      .catch((e) => toast.error(e.message))}
                >
                  <Radar size={13} />Discover more
                </Button>
              )}
            </div>

            {result.leads.length === 0 && result.diagnostics?.blockers?.length > 0 && (
              <Surface className="border-[color-mix(in_oklch,var(--color-caution)_40%,transparent)] p-5">
                <div className="flex items-start gap-3">
                  <Info size={16} className="mt-0.5 shrink-0 text-[var(--color-caution)]" />
                  <div className="min-w-0 space-y-2">
                    <p className="text-sm font-semibold">Why nothing matched</p>
                    <ul className="space-y-1.5">
                      {result.diagnostics.blockers.map((b) => (
                        <li key={b.key} className="text-[13px] leading-relaxed text-[var(--text-muted)]">
                          Removing the <span className="font-medium text-[var(--text)]">{b.label}</span> filter would
                          match <span className="tnum font-medium text-[var(--text)]">{b.wouldMatch}</span>{" "}
                          {b.wouldMatch === 1 ? "lead" : "leads"}.
                          {b.hint && <span className="block text-[var(--text-subtle)]">{b.hint}</span>}
                        </li>
                      ))}
                    </ul>
                    {result.diagnostics.unparsed?.length > 0 && (
                      <p className="text-[13px] text-[var(--text-muted)]">
                        These words were not understood:{" "}
                        {result.diagnostics.unparsed.map((w) => (
                          <code key={w} className="mx-0.5 rounded bg-[var(--surface-sunken)] px-1 py-px text-[11px]">{w}</code>
                        ))}
                      </p>
                    )}
                  </div>
                </div>
              </Surface>
            )}

            {result.leads.length === 0 && !runId && (
              <Surface>
                <EmptyState
                  icon={Radar}
                  title="Nothing stored for that query yet"
                  description="Run a discovery to search OpenStreetMap business records, company websites and public job boards for matching companies."
                  action={
                    result.query?.id && (
                      <Button
                        onClick={() =>
                          api.discoverForQuery(result.query.id)
                            .then((d) => setRunId(d.discoveryRunId))
                            .catch((e) => toast.error(e.message))}
                      >
                        <Radar size={14} />Discover now
                      </Button>
                    )}
                />
              </Surface>
            )}

            <div className="space-y-3">
              {result.leads.map((lead) => <LeadCard key={lead.id} lead={lead} />)}
            </div>
          </>
        )}

        {!result && !search.isPending && (
          <Surface className={cn("border-dashed")}>
            <EmptyState
              icon={Search}
              title="Start with a description"
              description="Name an industry, a place, and what you think is wrong or changing — for example “dental clinics in London without online booking”."
            />
          </Surface>
        )}
      </PageBody>
    </div>
  );
}
