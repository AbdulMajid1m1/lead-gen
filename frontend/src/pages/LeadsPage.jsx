import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Users, SlidersHorizontal, Mail, MessageCircle, CheckSquare, X, ShieldAlert } from "lucide-react";
import { PageBody, PageHeader } from "../App.jsx";
import { api } from "../lib/api.js";
import { LeadCard } from "../components/LeadCard.jsx";
import { Badge, Button, EmptyState, ErrorState, MultiSelect, SkeletonCard, Surface } from "../components/ui.jsx";
import { BulkSendSheet } from "../components/BulkSendSheet.jsx";
import { toast } from "sonner";
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

/**
 * The pipeline, as tabs. Each tab is nothing more than a saved status filter —
 * the counts come from the same where-clause as the list, so the badge numbers
 * and the rows can never disagree.
 */
const TABS = [
  { key: "pending", label: "Pending", status: "NEW,QUALIFIED", hint: "Not yet contacted" },
  { key: "contacted", label: "Contacted", status: "CONTACTED,FOLLOW_UP", hint: "Sent, awaiting a reply" },
  { key: "replied", label: "Replied", status: "REPLIED", hint: "They answered — your move" },
  { key: "all", label: "All", status: "", hint: "Everything active" },
];

export default function LeadsPage() {
  // `sort: "created"` is the default on purpose — the newest lead is the first
  // row until the user asks for something else.
  const [filters, setFilters] = useState({ service: "", status: "NEW,QUALIFIED", freshness: "", sort: "created", minScore: "", city: "" });
  const [countries, setCountries] = useState([]);
  const [page, setPage] = useState(1);
  // Selection for bulk send: a Set of lead ids plus what we know about their
  // reachability (used by the sheet's summary line).
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [selectionMeta, setSelectionMeta] = useState({ withEmail: 0, withPhone: 0, withWhatsApp: 0, emailBlocked: 0, blockedCountries: [] });
  const [sheet, setSheet] = useState(null); // null | { channels: [...] }
  const [selectingAll, setSelectingAll] = useState(false);

  const clearSelection = () => { setSelectedIds(new Set()); setSelectionMeta({ withEmail: 0, withPhone: 0, withWhatsApp: 0, emailBlocked: 0, blockedCountries: [] }); };
  const set = (key) => (value) => { setFilters((f) => ({ ...f, [key]: value })); setPage(1); clearSelection(); };
  const setCountry = (next) => { setCountries(next); setPage(1); clearSelection(); };

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
    // Keep the previous page rendered during a page flip so ticked selections
    // visibly carry across pages instead of the list blinking away.
    placeholderData: (prev) => prev,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  // Tab badges: same filters, status ignored, every stage counted.
  const { data: counts } = useQuery({
    queryKey: ["lead-status-counts", filters, countries],
    queryFn: () => api.leadStatusCounts({ ...filters, status: undefined, country: countries.join(",") }),
    staleTime: 15_000,
  });
  const tabCount = { pending: counts?.pending, contacted: counts?.contacted, replied: counts?.replied, all: counts?.all };
  const activeTab = TABS.find((t) => t.status === filters.status)?.key ?? null;

  const pageLeads = data?.leads || [];
  const pageAllSelected = pageLeads.length > 0 && pageLeads.every((l) => selectedIds.has(l.id));

  // Meta is adjusted lead-by-lead as the selection changes, never recounted
  // from the visible page — a recount would erase what was ticked on other
  // pages. It only needs to be roughly right; the server re-checks every lead
  // at send time anyway.
  const bump = (lead, dir) => setSelectionMeta((m) => ({
    withEmail: Math.max(0, m.withEmail + (lead.contact.hasEmail ? dir : 0)),
    withPhone: Math.max(0, m.withPhone + (lead.contact.hasPhone ? dir : 0)),
    // Distinct from hasPhone: a switchboard is a phone number but not a
    // WhatsApp account, and the bulk bar must not promise otherwise.
    withWhatsApp: Math.max(0, m.withWhatsApp + (lead.contact.hasWhatsApp ? dir : 0)),
    // Leads a campaign will refuse on legal grounds, counted as they are ticked
    // so the warning appears before the sheet is opened, not after.
    emailBlocked: Math.max(0, m.emailBlocked + (lead.compliance?.email?.policy === "BLOCKED" ? dir : 0)),
    blockedCountries: m.blockedCountries,
  }));

  const toggleLead = (lead) => {
    const wasSelected = selectedIds.has(lead.id);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (wasSelected) next.delete(lead.id); else next.add(lead.id);
      return next;
    });
    bump(lead, wasSelected ? -1 : +1);
  };

  const togglePage = () => {
    const adding = !pageAllSelected;
    const affected = pageLeads.filter((l) => selectedIds.has(l.id) !== adding);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      affected.forEach((l) => (adding ? next.add(l.id) : next.delete(l.id)));
      return next;
    });
    affected.forEach((l) => bump(l, adding ? +1 : -1));
  };

  // "Select all N matching" pulls the full id list (capped at 500 — the same
  // cap a campaign has) so bulk send is one click, not thirteen pages of ticks.
  const selectAllMatching = async () => {
    setSelectingAll(true);
    try {
      const res = await api.listLeadIds({ ...filters, country: countries.join(",") });
      setSelectedIds(new Set(res.ids));
      setSelectionMeta({
        withEmail: res.withEmail, withPhone: res.withPhone, withWhatsApp: res.withWhatsApp ?? 0,
        emailBlocked: res.emailBlocked ?? 0, blockedCountries: res.blockedCountries ?? [],
      });
      if (res.capped) toast.info("Selection capped at 500 leads — the campaign limit.");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSelectingAll(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="All leads"
        description="Every company the system has qualified, newest first. Filter by country, opportunity or freshness to get to the ones worth a conversation today."
      />

      {/* Extra bottom padding while the bulk bar is up, so the pagination row
          can always scroll clear of it. */}
      <PageBody className={cn("space-y-4", selectedIds.size > 0 && "pb-32 md:pb-24")}>
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Pipeline stage">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              role="tab"
              aria-selected={activeTab === tab.key}
              title={tab.hint}
              onClick={() => { set("status")(tab.status); }}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-[13px] font-medium transition-colors",
                activeTab === tab.key
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
              )}
            >
              {tab.label}
              {tabCount[tab.key] !== undefined && (
                <span className={cn(
                  "tnum rounded-md px-1.5 py-px text-[11px]",
                  activeTab === tab.key ? "bg-[color-mix(in_oklch,var(--accent)_18%,transparent)]" : "bg-[var(--surface-sunken)]",
                )}>
                  {tabCount[tab.key]}
                </span>
              )}
            </button>
          ))}
        </div>

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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-[var(--text-muted)]">
                <span className="font-semibold text-[var(--text)]">{data.total}</span> {data.total === 1 ? "lead" : "leads"}
              </p>
              {data.leads.length > 0 && (
                <div className="flex items-center gap-3 text-[13px]">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-[var(--text-muted)]">
                    <input type="checkbox" checked={pageAllSelected} onChange={togglePage} className="size-4 accent-[var(--accent)]" />
                    Select page
                  </label>
                  <button
                    onClick={selectAllMatching}
                    disabled={selectingAll}
                    className="inline-flex items-center gap-1.5 text-[var(--accent)] hover:underline disabled:opacity-50"
                  >
                    <CheckSquare size={13} />{selectingAll ? "Selecting…" : `Select all ${Math.min(data.total, 500)} matching`}
                  </button>
                </div>
              )}
            </div>

            {data.leads.length === 0 ? (
              <Surface className="border-dashed">
                <EmptyState
                  icon={Users}
                  title="No leads match these filters"
                  description="Loosen a filter, or run a discovery from the Find leads page to bring in new companies."
                />
              </Surface>
            ) : (
              <div className="space-y-3">
                {data.leads.map((lead) => (
                  <LeadCard
                    key={lead.id}
                    lead={lead}
                    selectable
                    selected={selectedIds.has(lead.id)}
                    onToggleSelect={toggleLead}
                  />
                ))}
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

      {/* Bulk action bar — appears with the first ticked lead, stays out of the
          way otherwise. Floats above the mobile bottom nav. The full-width
          wrapper must not eat clicks meant for content beside/behind the pill
          (the pagination buttons live in that band), so only the pill itself
          accepts pointer events. */}
      {selectedIds.size > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-16 z-40 flex justify-center px-4 md:bottom-5 md:pl-60">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 py-2.5 shadow-[var(--shadow-lg)]">
            <Badge tone="var(--accent)">{selectedIds.size} selected</Badge>
            <span className="hidden text-[11px] text-[var(--text-subtle)] sm:inline">
              {selectionMeta.withEmail} with email · {selectionMeta.withWhatsApp} reachable on WhatsApp · kept across pages
            </span>
            {selectionMeta.emailBlocked > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                style={{
                  backgroundColor: "color-mix(in oklch, var(--color-critical) 12%, transparent)",
                  color: "var(--color-critical)",
                }}
                title={`Cold email is not lawful in ${selectionMeta.blockedCountries.join(", ") || "these markets"}. These leads will be skipped; phone and WhatsApp may still be open.`}
              >
                <ShieldAlert size={11} />
                {selectionMeta.emailBlocked} cannot be emailed
              </span>
            )}
            <span className="mx-1 hidden h-4 w-px bg-[var(--border)] sm:inline" />
            <Button size="sm" onClick={() => setSheet({ channels: ["EMAIL"] })}>
              <Mail size={13} />Email
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setSheet({ channels: ["WHATSAPP"] })}>
              <MessageCircle size={13} />WhatsApp
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setSheet({ channels: ["EMAIL", "WHATSAPP"] })}>
              Both
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelection} aria-label="Clear selection">
              <X size={13} />
            </Button>
          </div>
        </div>
      )}

      <BulkSendSheet
        open={Boolean(sheet)}
        onClose={() => setSheet(null)}
        initialChannels={sheet?.channels || ["EMAIL"]}
        selection={{ ids: [...selectedIds], ...selectionMeta }}
      />
    </div>
  );
}
