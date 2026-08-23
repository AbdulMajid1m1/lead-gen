import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users, SlidersHorizontal } from "lucide-react";
import { PageBody, PageHeader } from "../App.jsx";
import { api } from "../lib/api.js";
import { LeadCard } from "../components/LeadCard.jsx";
import { Button, EmptyState, ErrorState, MultiSelect, SkeletonCard, Surface } from "../components/ui.jsx";
import { SERVICE_LABELS, STATUS_LABELS, FRESHNESS_LABELS, cn } from "../lib/format.js";

const Select = ({ label, value, onChange, options }) => (
  <label className="flex flex-col gap-1">
    <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">{label}</span>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-[13px] outline-none transition-colors focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)] shadow-[var(--shadow-xs)]"
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  </label>
);

export default function LeadsPage() {
  // `sort: "created"` is the default on purpose — the newest lead is the first
  // row until the user asks for something else.
  const [filters, setFilters] = useState({ service: "", status: "", freshness: "", sort: "created", minScore: "", city: "" });
  const [countries, setCountries] = useState([]);
  const [page, setPage] = useState(1);

  const set = (key) => (value) => { setFilters((f) => ({ ...f, [key]: value })); setPage(1); };
  const setCountry = (next) => { setCountries(next); setPage(1); };

  // The dropdown is built from the countries the leads actually have, so it can
  // never offer a country that returns nothing.
  const { data: countryData } = useQuery({
    queryKey: ["lead-countries"],
    queryFn: api.listLeadCountries,
    staleTime: 60_000,
  });

  const countryOptions = [
    ...(countryData?.countries || []).map((c) => ({ value: c.code, label: c.name, hint: c.leadCount })),
    ...(countryData?.unknown ? [{ value: "UNKNOWN", label: countryData.unknown.name, hint: countryData.unknown.leadCount }] : []),
  ];

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["leads", filters, countries, page],
    queryFn: () => api.listLeads({ ...filters, country: countries.join(","), page, pageSize: 25 }),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <PageHeader
        title="All leads"
        description="Every company the system has qualified, newest first. Filter by country, opportunity or freshness to get to the ones worth a conversation today."
      />

      <PageBody className="space-y-4">
        <Surface className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <SlidersHorizontal size={14} className="text-[var(--text-subtle)]" />
            <span className="text-sm font-medium">Filters</span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
            <Select
              label="Opportunity" value={filters.service} onChange={set("service")}
              options={[{ value: "", label: "Any" }, ...Object.entries(SERVICE_LABELS).map(([value, label]) => ({ value, label }))]}
            />
            <Select
              label="Status" value={filters.status} onChange={set("status")}
              options={[{ value: "", label: "Active" }, ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))]}
            />
            <Select
              label="Freshness" value={filters.freshness} onChange={set("freshness")}
              options={[{ value: "", label: "Any time" }, ...Object.entries(FRESHNESS_LABELS).map(([value, label]) => ({ value, label }))]}
            />
            <Select
              label="Min score" value={filters.minScore} onChange={set("minScore")}
              options={[{ value: "", label: "Any" }, { value: "40", label: "40+" }, { value: "55", label: "55+" }, { value: "70", label: "70+" }, { value: "85", label: "85+" }]}
            />
            <Select
              label="Sort by" value={filters.sort} onChange={set("sort")}
              options={[{ value: "created", label: "Newest first" }, { value: "score", label: "Score" }, { value: "freshness", label: "Freshest evidence" }]}
            />
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Country</span>
              <MultiSelect
                value={countries}
                onChange={setCountry}
                options={countryOptions}
                placeholder="All countries"
                summaryNoun="countries"
                className="px-2.5 py-1.5 text-[13px]"
              />
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">City</span>
              <input
                value={filters.city}
                onChange={(e) => set("city")(e.target.value)}
                placeholder="Any"
                className="rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2.5 py-1.5 text-[13px] outline-none transition-colors placeholder:text-[var(--text-subtle)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)] shadow-[var(--shadow-xs)]"
              />
            </label>
          </div>
        </Surface>

        {isPending && <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} />)}</div>}
        {isError && <ErrorState error={error} onRetry={refetch} />}

        {data && (
          <>
            <p className="text-sm text-[var(--text-muted)]">
              <span className="font-semibold text-[var(--text)]">{data.total}</span> {data.total === 1 ? "lead" : "leads"}
            </p>

            {data.leads.length === 0 ? (
              <Surface className="border-dashed">
                <EmptyState
                  icon={Users}
                  title="No leads match these filters"
                  description="Loosen a filter, or run a discovery from the Find leads page to bring in new companies."
                />
              </Surface>
            ) : (
              <div className="space-y-3">{data.leads.map((lead) => <LeadCard key={lead.id} lead={lead} />)}</div>
            )}

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 pt-2">
                <Button variant="secondary" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <span className="tnum text-sm text-[var(--text-muted)]">Page {page} of {totalPages}</span>
                <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            )}
          </>
        )}
      </PageBody>
    </div>
  );
}
