import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldOff, Trash2, Plus, Info, Signal } from "lucide-react";
import { toast } from "sonner";
import { PageBody, PageHeader } from "../App.jsx";
import { api } from "../lib/api.js";
import { Badge, Button, EmptyState, Skeleton, Surface, SectionHeading } from "../components/ui.jsx";
import EmailAccountsSection from "../components/EmailAccounts.jsx";
import WhatsAppSection from "../components/WhatsAppSection.jsx";
import SignaturesSection from "../components/Signatures.jsx";
import { formatDate, titleize } from "../lib/format.js";

export default function SettingsPage() {
  const [entry, setEntry] = useState({ kind: "DOMAIN", value: "", reason: "" });
  const queryClient = useQueryClient();

  const { data: suppression, isPending } = useQuery({ queryKey: ["suppression"], queryFn: api.listSuppression });
  const { data: catalog } = useQuery({ queryKey: ["catalog"], queryFn: api.signalCatalog, staleTime: Infinity });
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
            <ul className="divide-y divide-[var(--border)]">
              {suppression.entries.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge>{titleize(e.kind)}</Badge>
                      <span className="truncate font-mono text-[13px]">{e.value}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">
                      {e.reason || "No reason recorded"} · added {formatDate(e.createdAt)}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => remove.mutate(e.id)} aria-label={`Remove ${e.value}`}>
                    <Trash2 size={13} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Surface>

        <Surface className="p-5">
          <SectionHeading
            icon={Signal}
            title="Signal catalogue"
            description="What the system looks for, what each is worth, and how quickly it goes stale."
          />
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
                {(catalog?.signals || []).filter((s) => !s.isReachability).map((s) => (
                  <tr key={s.type}>
                    <td className="py-2 pr-3">{s.label}</td>
                    <td className="tnum py-2 pr-3 text-[var(--text-muted)]">{s.weight}</td>
                    <td className="py-2 pr-3 text-[var(--text-muted)]">{s.halfLifeDays ? `${s.halfLifeDays} days` : "no decay"}</td>
                    <td className="py-2 text-[var(--text-muted)]">
                      {s.services.map((v) => catalog.services[v] || v).join(", ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
      </PageBody>
    </div>
  );
}
