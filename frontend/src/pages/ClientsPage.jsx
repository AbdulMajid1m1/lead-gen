import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Handshake, Plus, Search, X, CalendarClock, FolderGit2, Users, SlidersHorizontal } from "lucide-react";
import { PageBody, PageHeader } from "../App.jsx";
import { api } from "../lib/api.js";
import { ClientCard } from "../components/ClientCard.jsx";
import { ClientFormSheet } from "../components/ClientFormSheet.jsx";
import { Button, EmptyState, ErrorState, Input, MultiSelect, Select, Skeleton, Surface } from "../components/ui.jsx";
import { cn } from "../lib/format.js";

/**
 * The client book.
 *
 * Its job is not "store clients" — it is "tell me who to call this week".
 * That is why the toolbar leads with a check-in filter rather than a status
 * filter, and why the summary strip counts people owed a conversation instead
 * of counting rows.
 */

const TABS = [
  { key: "all", label: "All clients", status: "", hint: "Everything except archived." },
  { key: "active", label: "Active", status: "ACTIVE", hint: "Work is running right now." },
  { key: "past", label: "Past", status: "PAST", hint: "Delivered and quiet — the reactivation list." },
  { key: "hold", label: "On hold", status: "ON_HOLD", hint: "Paused by them or by us." },
  { key: "archived", label: "Archived", status: "ARCHIVED", hint: "Hidden from every other view." },
];

const SORTS = [
  { value: "recent", label: "Recently updated" },
  { value: "quiet", label: "Quietest first" },
  { value: "followup", label: "Next check-in" },
  { value: "name", label: "Name (A–Z)" },
  { value: "added", label: "Recently added" },
];

const PAGE_SIZE = 24;

const StatTile = ({ icon: Icon, label, value, sub, tone, active, onClick }) => {
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      {...(onClick ? { onClick, type: "button", "aria-pressed": active } : {})}
      className={cn(
        "flex items-start gap-3 rounded-xl border bg-[var(--surface-raised)] p-4 text-left shadow-[var(--shadow-sm)] transition-colors",
        onClick && "hover:border-[var(--border-strong)]",
        active ? "border-[var(--accent)] ring-1 ring-[var(--accent)]" : "border-[var(--border)]",
      )}
    >
      <span className="rounded-lg bg-[var(--surface-sunken)] p-2">
        <Icon size={15} style={{ color: tone || "var(--text-subtle)" }} />
      </span>
      <span className="min-w-0">
        <span className="tnum block text-xl font-semibold tracking-tight">{value ?? "—"}</span>
        <span className="block text-[12px] font-medium">{label}</span>
        {sub && <span className="mt-0.5 block text-[11px] text-[var(--text-subtle)]">{sub}</span>}
      </span>
    </Wrapper>
  );
};

export default function ClientsPage() {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState("");
  const [countries, setCountries] = useState([]);
  const [tag, setTag] = useState("");
  const [due, setDue] = useState(false);
  const [sort, setSort] = useState("recent");
  const [page, setPage] = useState(1);
  const [sheet, setSheet] = useState(null); // null | { client }

  // Typing must not fire a request per keystroke, but must also not feel laggy.
  useEffect(() => {
    const timer = setTimeout(() => { setDebounced(search.trim()); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: facets } = useQuery({ queryKey: ["client-facets"], queryFn: api.clientFacets, staleTime: 30_000 });

  const params = useMemo(() => ({
    q: debounced,
    status,
    country: countries.join(","),
    tag,
    due: due ? "true" : "",
    sort,
    page,
    pageSize: PAGE_SIZE,
  }), [debounced, status, countries, tag, due, sort, page]);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["clients", params],
    queryFn: () => api.listClients(params),
    placeholderData: (prev) => prev,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const activeTab = TABS.find((t) => t.status === status)?.key ?? "all";
  const filtersApplied = Boolean(debounced || status || countries.length || tag || due);

  const reset = () => {
    setSearch(""); setDebounced(""); setStatus(""); setCountries([]); setTag(""); setDue(false); setPage(1);
  };
  const change = (setter) => (value) => { setter(value); setPage(1); };

  const countryOptions = (facets?.countries || []).map((c) => ({ value: c.code, label: c.name, hint: c.clientCount }));
  const tagOptions = facets?.tags || [];
  const bookIsEmpty = facets ? facets.total === 0 : false;

  return (
    <div>
      <PageHeader
        title="Clients"
        description="Everyone you have already worked for — who to call, what you built them, and when you last spoke. The list nobody keeps, and everybody needs."
        actions={<Button onClick={() => setSheet({ client: null })}><Plus size={14} />Add client</Button>}
      />

      <PageBody className="space-y-5">
        {/* ── The week's shape, in four numbers ── */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile icon={Users} label="Clients in the book" value={facets?.total} sub="Archived included" />
          <StatTile icon={Handshake} label="Active right now" value={facets?.activeCount} sub="Work in flight" tone="var(--color-positive)" />
          <StatTile
            icon={CalendarClock} label="Needs a check-in" value={facets?.dueCount}
            sub={due ? "Showing these — click to clear" : "Click to filter"}
            tone="var(--accent)" active={due}
            onClick={() => change(setDue)(!due)}
          />
          <StatTile icon={FolderGit2} label="Projects recorded" value={facets?.projectCount} sub="Across every client" tone="var(--color-info)" />
        </div>

        {/* ── Filters ── */}
        <Surface className="p-4">
          <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Relationship">
            {TABS.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={activeTab === tab.key}
                title={tab.hint}
                onClick={() => change(setStatus)(tab.status)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors",
                  activeTab === tab.key
                    ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
                )}
              >
                {tab.label}
                {facets && (
                  <span className={cn(
                    "tnum rounded-md px-1.5 py-px text-[11px]",
                    activeTab === tab.key ? "bg-[color-mix(in_oklch,var(--accent)_18%,transparent)]" : "bg-[var(--surface-sunken)]",
                  )}>
                    {tab.status ? facets.statusCounts[tab.status] : facets.total - facets.statusCounts.ARCHIVED}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="mt-3 grid gap-3 border-t border-[var(--border)] pt-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1 sm:col-span-2 lg:col-span-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Search</span>
              <div className="relative">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-subtle)]" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Name, person, email, project…"
                  aria-label="Search clients"
                  className="pl-8"
                />
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    aria-label="Clear search"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-[var(--text-subtle)] hover:text-[var(--text)]"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            </label>

            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Country</span>
              <MultiSelect
                value={countries}
                onChange={change(setCountries)}
                options={countryOptions}
                placeholder="All countries"
                summaryNoun="countries"
              />
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Tag</span>
              <Select value={tag} onChange={(e) => change(setTag)(e.target.value)} disabled={tagOptions.length === 0}>
                <option value="">{tagOptions.length ? "Any tag" : "No tags used yet"}</option>
                {tagOptions.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.clientCount})</option>)}
              </Select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Sort by</span>
              <Select value={sort} onChange={(e) => change(setSort)(e.target.value)}>
                {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
            </label>
          </div>

          {filtersApplied && (
            <div className="mt-3 flex items-center gap-2 border-t border-[var(--border)] pt-3">
              <SlidersHorizontal size={12} className="text-[var(--text-subtle)]" />
              <span className="text-[11px] text-[var(--text-muted)]">Filters are narrowing this list.</span>
              <Button variant="ghost" size="sm" onClick={reset}>Clear all</Button>
            </div>
          )}
        </Surface>

        {/* ── Results ── */}
        {isPending && (
          <div className="grid gap-3 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-56 rounded-xl" />)}
          </div>
        )}
        {isError && <ErrorState error={error} onRetry={refetch} />}

        {data && (
          <>
            <p className="text-sm text-[var(--text-muted)]">
              <span className="font-semibold text-[var(--text)]">{data.total}</span>{" "}
              {data.total === 1 ? "client" : "clients"}
              {due && " needing a check-in"}
            </p>

            {data.clients.length === 0 ? (
              <Surface className="border-dashed">
                {bookIsEmpty ? (
                  <EmptyState
                    icon={Handshake}
                    title="Your client book is empty"
                    description="Add the companies you have already worked for. Their people, their projects, and when you last spoke — so a maintenance renewal or a second project never gets forgotten."
                    action={<Button onClick={() => setSheet({ client: null })}><Plus size={14} />Add your first client</Button>}
                  />
                ) : (
                  <EmptyState
                    icon={Search}
                    title="No clients match these filters"
                    description="Try a different search, widen the relationship tabs, or clear the filters to see the whole book."
                    action={<Button variant="secondary" onClick={reset}>Clear filters</Button>}
                  />
                )}
              </Surface>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {data.clients.map((client) => <ClientCard key={client.id} client={client} />)}
              </div>
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

      <ClientFormSheet
        open={Boolean(sheet)}
        onClose={() => setSheet(null)}
        client={sheet?.client || null}
        tagSuggestions={tagOptions.map((t) => t.tag)}
      />
    </div>
  );
}
