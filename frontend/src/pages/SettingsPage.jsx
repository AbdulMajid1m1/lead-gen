import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldOff, Trash2, Plus, Info, Signal, Database, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { PageBody, PageHeader } from "../App.jsx";
import { api } from "../lib/api.js";
import { Badge, Button, EmptyState, Input, Skeleton, Surface, SectionHeading } from "../components/ui.jsx";
import { DataGridPagination } from "../components/DataGridPagination.jsx";
import EmailAccountsSection from "../components/EmailAccounts.jsx";
import AutopilotSection from "../components/Autopilot.jsx";
import WhatsAppSection from "../components/WhatsAppSection.jsx";
import SignaturesSection from "../components/Signatures.jsx";
import { formatDate, titleize } from "../lib/format.js";

export default function SettingsPage() {
  const [entry, setEntry] = useState({ kind: "DOMAIN", value: "", reason: "" });
  const queryClient = useQueryClient();

  const { data: suppression, isPending } = useQuery({ queryKey: ["suppression"], queryFn: api.listSuppression });
  const { data: catalog } = useQuery({ queryKey: ["catalog"], queryFn: api.signalCatalog, staleTime: Infinity });

  // The list runs to a few hundred rows once a bounce sweep has been through it,
  // and every one of them was rendered at once. Filtering happens client-side
  // because the whole list already arrives in one response.
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const filtered = useMemo(() => {
    const entries = suppression?.entries || [];
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      e.value?.toLowerCase().includes(q) || e.reason?.toLowerCase().includes(q));
  }, [suppression, filter]);

  // Deleting the last row of the last page would otherwise strand you on a page
  // that no longer exists.
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  // The catalogue is reference material — thirty rows you read once a month and
  // then scroll past for ever. Collapsed by default so the sections people
  // actually act on are reachable without a long scroll.
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalogFilter, setCatalogFilter] = useState("");
  const [catalogPage, setCatalogPage] = useState(1);
  const [catalogPageSize, setCatalogPageSize] = useState(10);

  const catalogRows = useMemo(() => {
    const rows = (catalog?.signals || []).filter((sig) => !sig.isReachability);
    const q = catalogFilter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((sig) =>
      sig.label?.toLowerCase().includes(q)
      || (sig.services || []).some((v) => (catalog.services?.[v] || v).toLowerCase().includes(q)));
  }, [catalog, catalogFilter]);

  const catalogPages = Math.max(1, Math.ceil(catalogRows.length / catalogPageSize));
  const catalogSafePage = Math.min(catalogPage, catalogPages);
  const catalogVisible = catalogRows.slice((catalogSafePage - 1) * catalogPageSize, catalogSafePage * catalogPageSize);
  const { data: health } = useQuery({ queryKey: ["health"], queryFn: api.health });

  const add = useMutation({
    mutationFn: () => api.addSuppression(entry),
    onSuccess: () => {
      toast.success("Added to the suppression list and applied to existing records.");
      setEntry({ kind: "DOMAIN", value: "", reason: "" });
      queryClient.invalidateQueries();
    },
    onError: (err) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: (id) => api.removeSuppression(id),
    onSuccess: () => { toast.success("Removed."); queryClient.invalidateQueries({ queryKey: ["suppression"] }); },
    onError: (err) => toast.error(err.message),
  });

  return (
    <div>
      <PageHeader title="Settings" description="Email senders, suppression list, scoring reference and system status." />

      <PageBody className="space-y-5">
        <EmailAccountsSection />
        <AutopilotSection />
        <WhatsAppSection />
        <SignaturesSection />

        <Surface className="p-5">
          <SectionHeading
            icon={ShieldOff}
            title="Suppression list"
            description="Anything listed here is excluded from discovery and hidden from results — applied retroactively as well as going forward."
          />

          <div className="mb-4 flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Type</span>
              <select
                value={entry.kind}
                onChange={(e) => setEntry((v) => ({ ...v, kind: e.target.value }))}
                className="mt-1 block rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2.5 py-2 text-[13px] outline-none transition-colors focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)] shadow-[var(--shadow-xs)]"
              >
                {["DOMAIN", "EMAIL", "COMPANY", "PHONE"].map((k) => <option key={k} value={k}>{titleize(k)}</option>)}
              </select>
            </label>
            <label className="block min-w-52 flex-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Value</span>
              <input
                value={entry.value}
                onChange={(e) => setEntry((v) => ({ ...v, value: e.target.value }))}
                placeholder={entry.kind === "DOMAIN" ? "example.com" : entry.kind === "EMAIL" ? "info@example.com" : "acme"}
                className="mt-1 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-2 text-sm outline-none transition-colors placeholder:text-[var(--text-subtle)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)] shadow-[var(--shadow-xs)]"
              />
            </label>
            <label className="block min-w-52 flex-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Reason (optional)</span>
              <input
                value={entry.reason}
                onChange={(e) => setEntry((v) => ({ ...v, reason: e.target.value }))}
                placeholder="Asked not to be contacted"
                className="mt-1 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--surface-raised)] px-3 py-2 text-sm outline-none transition-colors placeholder:text-[var(--text-subtle)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)] shadow-[var(--shadow-xs)]"
              />
            </label>
            <Button disabled={add.isPending || entry.value.trim().length < 2} onClick={() => add.mutate()}>
              <Plus size={14} />Add
            </Button>
          </div>

          {isPending && <Skeleton className="h-20" />}
          {suppression && suppression.entries.length === 0 && (
            <EmptyState icon={ShieldOff} title="Nothing suppressed" description="Add a domain, email or company here when someone asks not to be contacted." />
          )}
          {suppression && suppression.entries.length > 0 && (
            <>
              <div className="mb-3">
                <Input
                  className="w-full sm:max-w-xs"
                  placeholder="Filter by value or reason…"
                  value={filter}
                  onChange={(e) => { setFilter(e.target.value); setPage(1); }}
                />
              </div>

              {visible.length === 0 ? (
                <p className="py-6 text-center text-xs text-[var(--text-subtle)]">
                  Nothing matches “{filter}”.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-[13px]">
                    <thead className="text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">
                      <tr className="border-b border-[var(--border)]">
                        <th className="py-2 font-medium">Type</th>
                        <th className="py-2 font-medium">Value</th>
                        <th className="py-2 font-medium">Reason</th>
                        <th className="py-2 font-medium whitespace-nowrap">Added</th>
                        <th className="py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {visible.map((e) => (
                        <tr key={e.id} className="border-b border-[var(--border)] last:border-0">
                          <td className="py-2 pr-3"><Badge>{titleize(e.kind)}</Badge></td>
                          <td className="max-w-[240px] truncate py-2 pr-3 font-mono text-[12px]">{e.value}</td>
                          <td className="max-w-[280px] truncate py-2 pr-3 text-[var(--text-subtle)]">
                            {e.reason || "No reason recorded"}
                          </td>
                          <td className="whitespace-nowrap py-2 pr-3 text-[var(--text-subtle)]">{formatDate(e.createdAt)}</td>
                          <td className="py-2 text-right">
                            <Button variant="ghost" size="sm" onClick={() => remove.mutate(e.id)} aria-label={`Remove ${e.value}`}>
                              <Trash2 size={13} />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="mt-3">
                <DataGridPagination
                  page={safePage}
                  pageSize={pageSize}
                  total={filtered.length}
                  onPageChange={setPage}
                  onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
                />
              </div>
            </>
          )}
        </Surface>

        <Surface className="p-5">
          <SectionHeading
            icon={Signal}
            title="Signal catalogue"
            description="What the system looks for, what each is worth, and how quickly it goes stale."
            actions={
              <Button variant="ghost" size="sm" onClick={() => setCatalogOpen((v) => !v)}>
                {catalogOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                {catalogOpen ? "Hide" : `Show ${catalogRows.length}`}
              </Button>
            }
          />
          {catalogOpen && (
            <>
              <div className="mb-3">
                <Input
                  className="w-full sm:max-w-xs"
                  placeholder="Filter by signal or service…"
                  value={catalogFilter}
                  onChange={(e) => { setCatalogFilter(e.target.value); setCatalogPage(1); }}
                />
              </div>

              {catalogVisible.length === 0 ? (
                <p className="py-6 text-center text-xs text-[var(--text-subtle)]">
                  Nothing matches “{catalogFilter}”.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-left text-[13px]">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">
                        <th className="pb-2 font-medium">Signal</th>
                        <th className="pb-2 font-medium">Weight</th>
                        <th className="pb-2 font-medium">Half-life</th>
                        <th className="pb-2 font-medium">Points to</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      {catalogVisible.map((sig) => (
                        <tr key={sig.type}>
                          <td className="py-2 pr-3">{sig.label}</td>
                          <td className="tnum py-2 pr-3 text-[var(--text-muted)]">{sig.weight}</td>
                          <td className="py-2 pr-3 text-[var(--text-muted)]">{sig.halfLifeDays ? `${sig.halfLifeDays} days` : "no decay"}</td>
                          <td className="py-2 text-[var(--text-muted)]">
                            {sig.services.map((v) => catalog.services[v] || v).join(", ") || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="mt-3">
                <DataGridPagination
                  page={catalogSafePage}
                  pageSize={catalogPageSize}
                  total={catalogRows.length}
                  onPageChange={setCatalogPage}
                  onPageSizeChange={(n) => { setCatalogPageSize(n); setCatalogPage(1); }}
                />
              </div>
            </>
          )}
        </Surface>

        <Surface className="p-5">
          <SectionHeading icon={Info} title="System" />
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">Database</dt>
              <dd className="text-sm">
                <Badge tone={health?.checks?.database === "up" ? "var(--color-positive)" : "var(--color-critical)"}>
                  {health?.checks?.database === "up" ? "Connected" : "Unavailable"}
                </Badge>
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">AI layer</dt>
              <dd className="text-sm">
                <Badge tone={health?.ai?.available ? "var(--accent)" : health?.ai?.enabled ? "var(--color-critical)" : undefined}>
                  {health?.ai?.available ? "Active" : health?.ai?.enabled ? "Erroring — using templates" : "Disabled (optional)"}
                </Badge>
                {health?.ai?.enabled && !health?.ai?.available && (
                  <p className="mt-1 text-[11px] leading-snug text-[var(--text-muted)]">
                    {health.ai.providers?.openai?.pausedReason || health.ai.providers?.anthropic?.pausedReason
                      || "All configured AI providers are failing — check API keys and billing. The app keeps working on templates."}
                  </p>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">Uptime</dt>
              <dd className="tnum text-sm">{health ? `${Math.floor(health.uptimeSeconds / 60)} min` : "—"}</dd>
            </div>
          </dl>
          <p className="mt-4 border-t border-[var(--border)] pt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
            Crawling honours robots.txt, identifies itself with a contactable User-Agent, backs off on
            rate limits, and never attempts to bypass CAPTCHAs, logins or paywalls. Business data comes
            from OpenStreetMap (© OpenStreetMap contributors, ODbL), public applicant-tracking job
            boards and companies' own websites.
          </p>
        </Surface>

        <DatabaseBackupSection />
      </PageBody>
    </div>
  );
}

/**
 * Full database backup, gated behind a second password.
 *
 * The download is a gzip stream rather than JSON, so it goes through
 * api.downloadBackup rather than the usual request() path. A dump that fails
 * partway arrives as a network error by design — the server aborts the transfer
 * instead of ending it cleanly — and that case is reported plainly, because a
 * truncated backup that looks fine is worse than an obvious failure.
 */
function DatabaseBackupSection() {
  const [password, setPassword] = useState("");
  const [downloading, setDownloading] = useState(false);

  const run = async () => {
    if (!password || downloading) return;
    setDownloading(true);
    const toastId = toast.loading("Dumping the database… this can take a minute.");
    try {
      const { blob, filename } = await api.downloadBackup(password);

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Release the object URL once the browser has taken the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      setPassword("");
      toast.success(`Saved ${filename}.`, { id: toastId });
    } catch (err) {
      toast.error(err.message, { id: toastId, duration: 8000 });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Surface className="p-5">
      <SectionHeading icon={Database} title="Database backup" />
      <p className="text-[13px] leading-relaxed text-[var(--text-muted)]">
        Downloads every table as a gzipped SQL dump — leads, companies, contacts, signals and
        outreach history. Restore it onto any Postgres 16 host with:
      </p>
      <code className="mt-2 block overflow-x-auto rounded bg-[var(--surface-sunken)] px-2.5 py-1.5 text-[11px] whitespace-nowrap">
        gunzip &lt; leadsignal-backup-….sql.gz | psql "$DATABASE_URL"
      </code>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 sm:max-w-xs">
          <label htmlFor="backup-password" className="mb-1 block text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">
            Backup password
          </label>
          <Input
            id="backup-password"
            type="password"
            autoComplete="off"
            placeholder="Required to download"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") run(); }}
            disabled={downloading}
          />
        </div>
        <Button onClick={run} disabled={downloading || !password}>
          {downloading
            ? <><Loader2 size={14} className="mr-1.5 animate-spin" />Dumping…</>
            : <><Database size={14} className="mr-1.5" />Download backup</>}
        </Button>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
        Streamed live, so keep the tab open until it finishes. If the dump fails partway the download
        is aborted rather than completed — an incomplete file is never handed to you looking valid.
      </p>
    </Surface>
  );
}
