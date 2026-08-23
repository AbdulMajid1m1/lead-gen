import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts";
import { Search, TrendingUp, Building2, Briefcase, ShieldAlert, ArrowRight, Sparkles } from "lucide-react";
import { PageBody, PageHeader } from "../App.jsx";
import { api } from "../lib/api.js";
import { Button, EmptyState, ErrorState, Skeleton, Surface, SectionHeading, Badge } from "../components/ui.jsx";
import { SERVICE_LABELS, scoreTone, formatDateTime, titleize } from "../lib/format.js";

export default function DashboardPage() {
  const { data, isPending, isError, error, refetch } = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });

  if (isPending) {
    return (
      <div>
        <PageHeader title="Dashboard" description="Loading…" />
        <PageBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </PageBody>
      </div>
    );
  }
  if (isError) return <PageBody><ErrorState error={error} onRetry={refetch} /></PageBody>;

  const t = data.totals;
  const hasData = t.leads > 0 || t.companies > 0;

  return (
    <div>
      <PageHeader
        title="Lead intelligence"
        description="Freshness, relevance and evidence — at a glance."
        actions={<Link to="/search"><Button><Search size={14} />Find leads</Button></Link>}
      />

      <PageBody className="space-y-5">
        {!hasData ? (
          <Surface className="border-dashed">
            <EmptyState
              icon={Sparkles}
              title="No leads yet"
              description="Describe the kind of customer you want and LeadSignal will search public business records, company websites and live job boards to find them."
              action={<Link to="/search"><Button><Search size={14} />Find your first leads</Button></Link>}
            />
          </Surface>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard icon={TrendingUp} label="Qualified leads" value={t.leads} sub={`${t.newThisWeek} added this week`} />
              <StatCard icon={Sparkles} label="Fresh evidence" value={t.freshThisWeek} sub="updated in the last 7 days" tone="var(--color-positive)" />
              <StatCard icon={Building2} label="Companies tracked" value={t.companies} sub={`${t.crawlsOk} pages crawled`} />
              <StatCard icon={Briefcase} label="Active job posts" value={t.activeJobs} sub="board-confirmed right now" tone="var(--color-info)" />
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              <Surface className="p-5 lg:col-span-2">
                <SectionHeading title="Leads discovered" description="Last 30 days" />
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data.timeline} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <defs>
                        <linearGradient id="leadFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.28} />
                          <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="var(--border)" vertical={false} />
                      <XAxis
                        dataKey="date" tickLine={false} axisLine={false}
                        tick={{ fill: "var(--text-subtle)", fontSize: 10 }}
                        tickFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        minTickGap={28}
                      />
                      <YAxis tickLine={false} axisLine={false} tick={{ fill: "var(--text-subtle)", fontSize: 10 }} allowDecimals={false} width={30} />
                      <Tooltip
                        cursor={{ stroke: "var(--border-strong)" }}
                        contentStyle={{
                          background: "var(--surface-raised)", border: "1px solid var(--border)",
                          borderRadius: 10, fontSize: 12, color: "var(--text)", boxShadow: "var(--shadow-md)",
                        }}
                        labelFormatter={(d) => new Date(d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                        formatter={(value, name) => [value, name === "leads" ? "Leads" : "Avg score"]}
                      />
                      <Area type="monotone" dataKey="leads" stroke="var(--accent)" strokeWidth={2} fill="url(#leadFill)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </Surface>

              <Surface className="p-5">
                <SectionHeading title="Opportunity mix" description="What these leads need" />
                <ul className="space-y-2.5">
                  {data.byService.map((s) => {
                    const pct = t.leads ? Math.round((s.count / t.leads) * 100) : 0;
                    return (
                      <li key={s.service}>
                        <div className="mb-1 flex items-baseline justify-between text-xs">
                          <span className="text-[var(--text-muted)]">{s.label || SERVICE_LABELS[s.service]}</span>
                          <span className="tnum font-medium">{s.count}</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-sunken)]">
                          <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
                        </div>
                      </li>
                    );
                  })}
                  {data.byService.length === 0 && <p className="text-sm text-[var(--text-muted)]">No leads scored yet.</p>}
                </ul>
              </Surface>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Surface className="p-5">
                <SectionHeading
                  title="Best leads right now"
                  actions={<Link to="/leads" className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline">View all<ArrowRight size={11} /></Link>}
                />
                <ul className="divide-y divide-[var(--border)]">
                  {data.topLeads.map((l) => (
                    <li key={l.id}>
                      <Link to={`/leads/${l.id}`} className="flex items-start gap-3 py-2.5 first:pt-0">
                        <span className="tnum mt-0.5 shrink-0 text-sm font-semibold" style={{ color: scoreTone(l.score) }}>{l.score}</span>
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium">{l.name}</p>
                          <p className="line-clamp-2 text-[11px] leading-snug text-[var(--text-muted)]">{l.topReason || SERVICE_LABELS[l.primaryOpportunity]}</p>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Surface>

              <Surface className="p-5">
                <SectionHeading icon={ShieldAlert} title="Sources in use" description="Everything below is public and permitted." />
                <ul className="divide-y divide-[var(--border)]">
                  {data.sources.filter((s) => s.records > 0).map((s) => (
                    <li key={s.kind + s.name} className="flex items-center justify-between gap-3 py-2 first:pt-0">
                      <div className="min-w-0">
                        <p className="truncate text-[13px]">{s.name}</p>
                        {s.attribution && <p className="truncate text-[10px] text-[var(--text-subtle)]">{s.attribution}</p>}
                      </div>
                      <span className="tnum shrink-0 text-xs text-[var(--text-muted)]">{s.records}</span>
                    </li>
                  ))}
                  {data.sources.every((s) => s.records === 0) && <p className="text-sm text-[var(--text-muted)]">No source records yet.</p>}
                </ul>
                {t.crawlsBlocked > 0 && (
                  <p className="mt-3 border-t border-[var(--border)] pt-3 text-[11px] text-[var(--text-muted)]">
                    {t.crawlsBlocked} page fetches were refused (robots.txt, bot protection or errors) and recorded rather than retried aggressively.
                  </p>
                )}
              </Surface>
            </div>

            {data.recentRuns.length > 0 && (
              <Surface className="p-5">
                <SectionHeading
                  title="Recent discovery runs"
                  actions={<Link to="/discovery" className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline">All runs<ArrowRight size={11} /></Link>}
                />
                <ul className="divide-y divide-[var(--border)]">
                  {data.recentRuns.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0">
                      <div className="min-w-0">
                        <p className="truncate text-[13px]">{r.query || `${titleize(r.trigger)} run`}</p>
                        <p className="text-[11px] text-[var(--text-subtle)]">{formatDateTime(r.createdAt)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {r.stats?.leadsCreated > 0 && <Badge tone="var(--color-positive)">{r.stats.leadsCreated} leads</Badge>}
                        <Badge>{titleize(r.status)}</Badge>
                      </div>
                    </li>
                  ))}
                </ul>
              </Surface>
            )}
          </>
        )}
      </PageBody>
    </div>
  );
}

const StatCard = ({ icon: Icon, label, value, sub, tone }) => (
  <Surface className="p-4">
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium text-[var(--text-muted)]">{label}</span>
      <Icon size={14} style={{ color: tone || "var(--text-subtle)" }} />
    </div>
    <p className="tnum mt-2 text-2xl font-semibold tracking-tight" style={tone ? { color: tone } : undefined}>{value}</p>
    {sub && <p className="mt-0.5 text-[11px] text-[var(--text-subtle)]">{sub}</p>}
  </Surface>
);
