import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Rocket, Globe, CornerDownLeft, X, Plus, ExternalLink, ArrowLeft, Search,
  AlertTriangle, RefreshCw, Archive, Mail, MessageCircle, PenLine,
  ShieldCheck, ShieldAlert, Sparkles, Users, MapPin, Target, Ban, Swords, Wallet, Coins,
  Quote, ListChecks, Compass, Radar, Clock, Layers, FileSearch, Phone, User,
  SlidersHorizontal, CheckSquare, Table2,
} from "lucide-react";
import { toast } from "sonner";
import { PageBody } from "../App.jsx";
import { api, subscribeToRun } from "../lib/api.js";
import { useServerGrid } from "../hooks/useServerGrid.js";
import { DataGrid } from "../components/DataGrid.jsx";
import {
  Badge, Button, EmptyState, ErrorState, Field, FormField, Input, MultiSelect, Select,
  SectionHeading, Skeleton, Spinner, Surface, Textarea,
} from "../components/ui.jsx";
import { DiscoveryProgress } from "../components/DiscoveryProgress.jsx";
import EmailComposer from "../components/EmailComposer.jsx";
import { BulkSendSheet } from "../components/BulkSendSheet.jsx";
import { ProvenanceDrawer } from "../components/ProvenanceDrawer.jsx";
import { COUNTRY_OPTIONS, countryLabel } from "../lib/countries.js";
import {
  FRESHNESS_LABELS, SERVICE_LABELS, STATUS_LABELS, STATUS_TONE,
  cn, formatDateTime, freshnessTone, prettyUrl, relativeTime, scoreTone,
} from "../lib/format.js";

/* ────────────────────────────────────────────────────────────────────────────
 * SaaS Promoter — leads first, profile second.
 *
 * The previous version of this page opened on a 700-line ICP form and rendered
 * the leads — the entire point of the feature — only when the URL happened to
 * carry `?run=`, below the fold of that form. A product now opens on its leads,
 * in the same grid, with the same filters and the same sending path as the All
 * leads page; the profile and the run history are tabs beside them.
 *
 * Map of this file
 * ────────────────
 *   PromoterPage       route switch — `?product=` opens a workspace, else landing
 *   ProductLanding     the URL/search bar, the product cards, the explainer
 *     ProductCard      one product, with its own live status / lead / run counts
 *   ProductWorkspace   header, tabs, and the ICP form state the tabs share
 *     LeadsTab         DataGrid + filters + selection + sending   (the default)
 *       leadColumns · LeadFilterBar · FilterSelect · BulkBar
 *     RunsTab          "Find leads" plus every past run
 *     ProfileTab       read-only research beside the editable ICP
 *       ProductProfile · IcpEditor
 *       TagListField · RepeatableRows · IcpSection   (shared by nine sections)
 *       toForm · toIcpPayload · starterForm          (the form model)
 * ────────────────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────────────────────
 * Vocabulary
 * ────────────────────────────────────────────────────────────────────────── */

const STATUS_META = {
  RESEARCHING: { label: "Reading the site", tone: "var(--color-info)" },
  ICP_REVIEW: { label: "Needs your approval", tone: "var(--accent)" },
  READY: { label: "Approved", tone: "var(--color-positive)" },
  FAILED: { label: "Research failed", tone: "var(--color-critical)" },
  ARCHIVED: { label: "Archived", tone: "var(--text-subtle)" },
};

const IN_FLIGHT = ["PENDING", "RUNNING"];

const runTone = (status) =>
  IN_FLIGHT.includes(status) ? "var(--color-info)"
  : status === "FAILED" ? "var(--color-critical)"
  : "var(--color-positive)";

const TABS = [
  { key: "leads", label: "Leads", icon: Table2 },
  { key: "profile", label: "Profile & ICP", icon: Users },
  { key: "runs", label: "Runs", icon: Radar },
];

/**
 * How a buying signal can actually be spotted. The label answers "and how would
 * we know?" in the user's words — the enum value alone reads like a database
 * column and tells a non-engineer nothing about what the search will do.
 */
const DETECTABLE_VIA = [
  ["JOB_POSTING", "A job they are advertising"],
  ["TECH_STACK", "The software running on their site"],
  ["COMPANY_AGE", "How long the company has existed"],
  ["WEBSITE_CONTENT", "Something written on their website"],
  ["DIRECTORY_LISTING", "A listing in a public directory"],
  ["SIGNAL_CATALOG", "A signal we already track"],
  ["OTHER", "Something else — describe it above"],
];

const PRIORITIES = [
  [1, "1 — search here first"],
  [2, "2 — worth searching"],
  [3, "3 — only if the first two run dry"],
];

const LIMITS = { name: 160, pitchAngle: 400, proofLink: 300, senderContext: 400 };

/**
 * The server's own limits on an approved profile, mirrored here so the ceiling
 * is visible while you type rather than announced as a rejection after you have
 * written twelve industries and pressed approve. Kept in one block so the day
 * the backend caps move, there is exactly one place to follow it.
 */
const CAPS = {
  summary: 600,
  industries: 8, industryText: 120,
  sizeNote: 400,
  geographies: 8, region: 120, reason: 400,
  titles: 8, titleText: 120,
  painPoints: 8, painText: 400,
  buyingSignals: 8, signalText: 400,
  disqualifiers: 8, disqualifierText: 400,
  competitors: 8, competitorText: 120,
  strategies: 5, strategyLabel: 120, strategyInstruction: 600,
  sourceTypes: 8,
};

/* ────────────────────────────────────────────────────────────────────────────
 * Small helpers
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Row keys for the repeatable ICP sections.
 *
 * Deliberately not the array index: these rows are edited, reordered by
 * deletion, and re-rendered on every keystroke, and an index key makes React
 * reuse the wrong input — you delete row 2 and row 3's text appears to move up
 * while the focus stays put. A per-row id costs nothing and removes the class
 * of bug entirely.
 */
let rowSeq = 0;
const uid = () => `row-${++rowSeq}`;

const withIds = (list) => (Array.isArray(list) ? list : []).map((row) => ({ ...row, _id: uid() }));
const stripIds = (list) => list.map(({ _id, ...rest }) => rest);
const asStrings = (list) => (Array.isArray(list) ? list.filter((v) => typeof v === "string" && v.trim()) : []);

/**
 * A pasted product URL, made into something fetchable — or null if it cannot be.
 * People type "tracefyhr.com", so a missing scheme is not an error, but a value
 * with no dot in the host is: it would send the crawler at a hostname that
 * cannot resolve.
 */
const normalizeUrl = (raw) => {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(parsed.hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

const isHttpUrl = (raw) => {
  try {
    const parsed = new URL(String(raw).trim());
    return /^https?:$/.test(parsed.protocol);
  } catch {
    return false;
  }
};

const StatusBadge = ({ status }) => {
  const meta = STATUS_META[status] || { label: status || "Unknown", tone: "var(--text-subtle)" };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
};

/** The affordance that lets a claim be checked. Every extracted fact gets one. */
const SourceLink = ({ href }) => {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`Check this on ${prettyUrl(href)}`}
      aria-label={`Check this claim on ${prettyUrl(href)}`}
      className="inline-flex shrink-0 items-center rounded p-0.5 text-[var(--text-subtle)] transition-colors hover:text-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)]"
    >
      <ExternalLink size={11} />
    </a>
  );
};

/* ────────────────────────────────────────────────────────────────────────────
 * Page
 * ────────────────────────────────────────────────────────────────────────── */

export default function PromoterPage() {
  const [params, setParams] = useSearchParams();
  const productId = params.get("product");

  return productId
    ? <ProductWorkspace key={productId} productId={productId} params={params} setParams={setParams} />
    : <ProductLanding onOpen={(id) => setParams({ product: id, tab: "leads" })} />;
}

/* ── 1. Landing ──────────────────────────────────────────────────────────── */

function ProductLanding({ onOpen }) {
  const [url, setUrl] = useState("");
  const [touched, setTouched] = useState(false);
  const inputRef = useRef(null);
  const queryClient = useQueryClient();

  useEffect(() => { inputRef.current?.focus(); }, []);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["promoted-products"],
    queryFn: () => api.listPromotedProducts(),
  });

  const create = useMutation({
    mutationFn: (normalized) => api.createPromotedProduct({ url: normalized }).then((payload) => payload.product),
    onSuccess: (product) => {
      toast.success(`Reading ${prettyUrl(product.url)} — this usually takes a minute or two.`);
      queryClient.invalidateQueries({ queryKey: ["promoted-products"] });
      onOpen(product.id);
    },
    onError: (err) => toast.error(err.message),
  });

  const normalized = normalizeUrl(url);
  const urlError = touched && url.trim() && !normalized
    ? "That does not look like a website address. Try something like tracefyhr.com."
    : null;

  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (!normalized) return;
    create.mutate(normalized);
  };

  const products = useMemo(() => {
    const rows = data?.products || (Array.isArray(data) ? data : []);
    return [...rows].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  }, [data]);

  // The one box both searches and adds. Typing "tracefyhr.com" for a product
  // that is already here should surface its card rather than quietly offer to
  // research it a second time — that is the first thing anyone tries.
  const needle = url.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const matches = useMemo(() => {
    if (!needle) return products;
    return products.filter((p) => `${p.name || ""} ${prettyUrl(p.url)} ${p.url}`.toLowerCase().includes(needle));
  }, [products, needle]);

  const alreadyHere = needle.length > 0 && matches.length > 0;

  return (
    <div>
      <div className="border-b border-[var(--border)] bg-[var(--surface-raised)]">
        <div className="mx-auto max-w-6xl px-5 py-8 md:px-8">
          <div className="mb-4 flex items-center gap-2">
            <Rocket size={16} className="text-[var(--accent)]" />
            <h1 className="text-lg font-semibold tracking-tight">SaaS Promoter</h1>
          </div>

          <form onSubmit={submit} noValidate>
            <FormField
              label="Paste your product's website"
              help={
                alreadyHere
                  ? "Already here — open its card below to see the leads it has found."
                  : "We read the public pages — what it does, what it costs, who already uses it — and work out who would buy it. Nothing is contacted at this stage."
              }
              error={urlError}
            >
              {(controlProps) => (
                <div className="relative">
                  <Globe size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-subtle)]" />
                  <input
                    {...controlProps}
                    ref={inputRef}
                    value={url}
                    inputMode="url"
                    autoComplete="url"
                    onChange={(e) => setUrl(e.target.value)}
                    onBlur={() => setTouched(true)}
                    placeholder="tracefyhr.com"
                    className={cn(
                      "w-full rounded-xl border bg-[var(--surface-raised)] py-3.5 pl-11 pr-36 text-[15px] shadow-[var(--shadow-xs)] outline-none transition-colors placeholder:text-[var(--text-subtle)] focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)]",
                      urlError ? "border-[var(--color-critical)]" : "border-[var(--border-strong)]",
                    )}
                  />
                  <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                    {url && (
                      <Button
                        type="button" variant="ghost" size="sm" aria-label="Clear"
                        onClick={() => { setUrl(""); setTouched(false); inputRef.current?.focus(); }}
                      >
                        <X size={14} />
                      </Button>
                    )}
                    <Button type="submit" size="sm" disabled={create.isPending || !normalized}>
                      {create.isPending ? <><Spinner size={12} />Reading…</> : <>Research it <CornerDownLeft size={12} /></>}
                    </Button>
                  </div>
                </div>
              )}
            </FormField>
          </form>
        </div>
      </div>

      <PageBody className="space-y-4">
        {isPending && (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {["a", "b", "c", "d"].map((k) => <Skeleton key={`product-skeleton-${k}`} className="h-40 rounded-xl" />)}
          </div>
        )}

        {isError && <Surface><ErrorState error={error} onRetry={refetch} /></Surface>}

        {!isPending && !isError && products.length === 0 && (
          <Surface className="border-dashed">
            <EmptyState
              icon={Rocket}
              title="Promote a product you already have"
              description="Paste its address above and three things happen, in this order."
              action={<HowItWorks />}
            />
          </Surface>
        )}

        {products.length > 0 && (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold tracking-tight">Your products</h2>
              <p className="tnum text-[11px] text-[var(--text-subtle)]">
                {needle ? `${matches.length} of ${products.length} shown` : `${products.length} total`}
              </p>
            </div>

            {matches.length === 0 ? (
              <Surface className="border-dashed">
                <EmptyState
                  icon={Search}
                  title={`Nothing here matches “${url.trim()}”`}
                  description={
                    normalized
                      ? "It has not been added yet — press “Research it” above and we will read the site."
                      : "Clear the box to see every product, or type a full address to add a new one."
                  }
                />
              </Surface>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {matches.map((product) => (
                  <li key={product.id}>
                    <ProductCard product={product} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {products.length > 0 && <HowItWorks />}
      </PageBody>
    </div>
  );
}

/**
 * One product tile.
 *
 * The list endpoint answers without runs or lead counts, so the two numbers
 * that make a card worth clicking are fetched per card. Both go under the keys
 * the workspace already uses, so opening a product renders from cache instead
 * of showing a second loading state for data the card had in hand.
 */
function ProductCard({ product, onOpen }) {
  const { data: detail } = useQuery({
    queryKey: ["promoted-product", product.id],
    queryFn: () => api.getPromotedProduct(product.id).then((d) => d.product),
    refetchInterval: (query) => (query.state.data?.status === "RESEARCHING" ? 4000 : false),
    staleTime: 15_000,
  });

  const { data: counts } = useQuery({
    queryKey: ["lead-status-counts", { productId: product.id }],
    queryFn: () => api.leadStatusCounts({ productId: product.id }),
    staleTime: 30_000,
  });

  const runs = detail?.runs || [];
  const lastRun = runs[0] || null;
  const running = runs.some((r) => IN_FLIGHT.includes(r.status));

  return (
    <button
      type="button"
      onClick={() => onOpen(product.id)}
      className="flex h-full w-full flex-col rounded-xl border border-[var(--border)] bg-[var(--surface-raised)] p-4 text-left shadow-[var(--shadow-sm)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-sunken)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{product.name || prettyUrl(product.url)}</p>
          <p className="truncate font-mono text-[11px] text-[var(--text-subtle)]">{prettyUrl(product.url)}</p>
        </div>
        <StatusBadge status={detail?.status || product.status} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <dt className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Leads</dt>
          <dd className="tnum text-lg font-semibold leading-tight">
            {counts?.all === undefined ? <span className="text-[var(--text-subtle)]">—</span> : counts.all}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Runs</dt>
          <dd className="tnum text-lg font-semibold leading-tight">
            {detail ? runs.length : <span className="text-[var(--text-subtle)]">—</span>}
          </dd>
        </div>
      </dl>

      <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--border)] pt-2.5 text-[11px] text-[var(--text-muted)]">
        {running && <span className="inline-flex items-center gap-1 text-[var(--color-info)]"><Spinner size={10} />searching now</span>}
        {!running && lastRun && <span>Last run {relativeTime(lastRun.createdAt)}</span>}
        {!running && !lastRun && detail && <span className="text-[var(--text-subtle)]">No search run yet</span>}
        <span className="text-[var(--text-subtle)]">·</span>
        <span>Updated {relativeTime(product.updatedAt)}</span>
      </p>
    </button>
  );
}

const HowItWorks = () => (
  <ol className="grid w-full gap-2 text-left sm:grid-cols-3">
    {[
      [Search, "We research your product", "The crawler reads its public pages and pulls out features, pricing and proof, each with the page it came from."],
      [ShieldCheck, "You approve who to target", "We draft an ideal customer profile. You edit it and approve it. Until you do, no search runs and nobody is contacted."],
      [Radar, "We find and write to them", "Companies matching your approved profile, verified the same way as every other lead, ready for the email composer."],
    ].map(([Icon, title, body], index) => (
      <li key={title} className="rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="tnum flex size-5 items-center justify-center rounded-full bg-[var(--accent-soft)] text-[10px] font-semibold text-[var(--accent)]">
            {index + 1}
          </span>
          <Icon size={13} className="text-[var(--text-subtle)]" />
        </div>
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)]">{body}</p>
      </li>
    ))}
  </ol>
);

/* ── 2. One product: header, tabs, and the state the tabs share ──────────── */

function ProductWorkspace({ productId, params, setParams }) {
  const queryClient = useQueryClient();
  // The ICP form lives up here rather than in the Profile tab so a half-written
  // profile survives a trip to the Leads tab and back.
  const [form, setForm] = useState(null);
  const [baseline, setBaseline] = useState(null);

  const requestedTab = params.get("tab");
  const tab = TABS.some((t) => t.key === requestedTab) ? requestedTab : "leads";

  const { data: product, isPending, isError, error, refetch } = useQuery({
    queryKey: ["promoted-product", productId],
    // Unwrapped here rather than through `select`, so what is cached is the
    // product itself — the poll below reads the cache directly, and a `select`
    // would leave it inspecting the envelope and never firing.
    queryFn: () => api.getPromotedProduct(productId).then((data) => data.product),
    refetchInterval: (query) => (query.state.data?.status === "RESEARCHING" ? 4000 : false),
  });

  const dirty = Boolean(form && baseline) && JSON.stringify(form) !== JSON.stringify(baseline);
  // Read inside the sync effect below, which must not re-run when dirty flips.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // Adopt whatever the server last said — unless the user is mid-edit, in which
  // case a background poll must never overwrite their typing.
  useEffect(() => {
    if (!product || dirtyRef.current) return;
    const next = toForm(product);
    setForm(next);
    setBaseline(next);
  }, [product]);

  // The browser's own guard. Crude, but it is the only thing that catches a
  // closed tab, and losing a hand-edited ICP is a genuinely expensive mistake.
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const confirmLeave = useCallback(() => {
    if (!dirty) return true;
    return window.confirm("You have unsaved changes to this customer profile. Leave and lose them?");
  }, [dirty]);

  const goBack = () => { if (confirmLeave()) setParams({}); };

  // Tabs replace rather than push: flipping between Leads and Profile four
  // times should not cost four presses of Back to escape the page.
  const setTab = useCallback(
    (next) => setParams({ product: productId, tab: next }, { replace: true }),
    [productId, setParams],
  );

  const runs = useMemo(
    () => [...(product?.runs || [])].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
    [product?.runs],
  );
  const activeRun = runs.find((r) => IN_FLIGHT.includes(r.status)) || null;

  // A finishing run is the only thing that puts new rows in the Leads tab, and
  // the product query only polls while the *site* is being read — so the run's
  // own event stream is what refreshes the grid underneath it.
  useEffect(() => {
    if (!activeRun?.runId) return undefined;
    return subscribeToRun(activeRun.runId, (event) => {
      if (["step.finished", "run.finished"].includes(event.type)) {
        queryClient.invalidateQueries({ queryKey: ["promoted-product", productId] });
        queryClient.invalidateQueries({ queryKey: ["promoter-leads", productId] });
        queryClient.invalidateQueries({ queryKey: ["lead-status-counts"] });
      }
    }, () => {});
  }, [activeRun?.runId, productId, queryClient]);

  const save = useMutation({
    // The name lives on the product; the rest travels with the approval so the
    // profile and the copy it drives are committed in one act. `icp` is never
    // sent to the PATCH — doing so retracts the approval.
    mutationFn: async () => {
      await api.updatePromotedProduct(productId, { name: form.name.trim() });
      return api.savePromotedProductIcp(productId, {
        icp: toIcpPayload(form),
        pitchAngle: form.pitchAngle.trim(),
        proofLink: form.proofLink.trim(),
        senderContext: form.senderContext.trim(),
      });
    },
    onSuccess: () => {
      setBaseline(form);
      toast.success("Profile approved. Searches will now use exactly this — you can change it and approve again at any time.");
      queryClient.invalidateQueries({ queryKey: ["promoted-product", productId] });
      queryClient.invalidateQueries({ queryKey: ["promoted-products"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const research = useMutation({
    mutationFn: () => api.researchPromotedProduct(productId),
    onSuccess: () => {
      toast.success("Reading the site again.");
      queryClient.invalidateQueries({ queryKey: ["promoted-product", productId] });
    },
    onError: (err) => toast.error(err.message),
  });

  const archive = useMutation({
    mutationFn: () => api.archivePromotedProduct(productId),
    onSuccess: () => {
      toast.success("Archived. Its leads and past runs are untouched.");
      queryClient.invalidateQueries({ queryKey: ["promoted-products"] });
      setParams({});
    },
    onError: (err) => toast.error(err.message),
  });

  const launch = useMutation({
    mutationFn: () => api.launchPromoterRun(productId, {}),
    onSuccess: (data) => {
      const newRunId = data?.runId || data?.id;
      if (!newRunId) {
        toast.error("The run started but the server did not say which one. Check Discovery runs.");
        return;
      }
      toast.success("Searching for companies that match your approved profile.");
      queryClient.invalidateQueries({ queryKey: ["promoted-product", productId] });
      // Leads arrive one at a time while the run works, so the run sends you to
      // where they will appear rather than leaving you on a list of runs.
      setTab("leads");
    },
    onError: (err) => toast.error(err.message),
  });

  /* ── loading / error ─────────────────────────────────────────────────── */

  if (isPending) {
    return (
      <div>
        <div className="border-b border-[var(--border)] bg-[var(--surface-raised)]">
          <div className="mx-auto max-w-6xl px-5 py-6 md:px-8"><Skeleton className="h-8 w-56" /></div>
        </div>
        <PageBody className="space-y-3">
          <Skeleton className="h-9 w-72 rounded-lg" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </PageBody>
      </div>
    );
  }

  if (isError) {
    return (
      <div>
        <WorkspaceHeader onBack={() => setParams({})} />
        <PageBody><Surface><ErrorState error={error} onRetry={refetch} /></Surface></PageBody>
      </div>
    );
  }

  return (
    <div>
      <WorkspaceHeader
        onBack={goBack}
        product={product}
        dirty={dirty}
        onArchive={() => archive.mutate()}
        archiving={archive.isPending}
        tab={tab}
        onTab={setTab}
      />

      {tab === "leads" && (
        <LeadsTab productId={productId} product={product} activeRun={activeRun} onOpenTab={setTab} />
      )}

      {tab === "runs" && (
        <RunsTab
          product={product}
          runs={runs}
          activeRun={activeRun}
          dirty={dirty}
          onLaunch={() => launch.mutate()}
          launching={launch.isPending}
          onOpenTab={setTab}
        />
      )}

      {tab === "profile" && (
        <ProfileTab
          product={product}
          form={form}
          setForm={setForm}
          dirty={dirty}
          onDiscard={() => setForm(baseline)}
          onApprove={() => save.mutate()}
          saving={save.isPending}
          onResearch={() => research.mutate()}
          researching={research.isPending}
        />
      )}
    </div>
  );
}

const WorkspaceHeader = ({ onBack, product, dirty, onArchive, archiving, tab, onTab }) => (
  <div className="border-b border-[var(--border)] bg-[var(--surface-raised)]">
    <div className="mx-auto max-w-6xl px-5 pt-6 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to your products">
            <ArrowLeft size={14} />
            <span className="hidden sm:inline">Products</span>
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight">
              {product?.name || (product ? prettyUrl(product.url) : "Product")}
            </h1>
            {product && (
              <a
                href={product.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 truncate font-mono text-[11px] text-[var(--text-subtle)] hover:text-[var(--accent)] hover:underline"
              >
                {prettyUrl(product.url)}<ExternalLink size={9} />
              </a>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {dirty && <Badge tone="var(--color-caution)">Unsaved changes</Badge>}
          {product && <StatusBadge status={product.status} />}
          {product && product.status !== "ARCHIVED" && (
            <Button variant="ghost" size="sm" onClick={onArchive} disabled={archiving} title="Archive this product">
              <Archive size={13} /><span className="hidden sm:inline">Archive</span>
            </Button>
          )}
        </div>
      </div>

      {product && (
        <div className="mt-4 flex gap-1 overflow-x-auto" role="tablist" aria-label="Product sections">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => onTab(key)}
              className={cn(
                "-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-2.5 text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)]",
                tab === key
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]",
              )}
            >
              <Icon size={13} />{label}
              {key === "profile" && dirty && (
                <span className="size-1.5 rounded-full bg-[var(--color-caution)]" title="Unsaved changes" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  </div>
);

const ArchivedNotice = () => (
  <Surface className="border-dashed p-4">
    <div className="flex items-start gap-3">
      <Archive size={16} className="mt-0.5 shrink-0 text-[var(--text-subtle)]" />
      <div>
        <h2 className="text-sm font-semibold">This product is archived</h2>
        <p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">
          It is kept for the record and no longer runs searches. Its leads and past runs are still here and can
          still be worked — nothing new will be found for it.
        </p>
      </div>
    </div>
  </Surface>
);

/* ── 3. Leads tab ────────────────────────────────────────────────────────── */

/**
 * The pipeline, as tabs. Each is a saved status filter, and the counts come
 * from the same where-clause as the rows — so a badge and its grid can never
 * disagree about how many leads there are.
 */
const PIPELINE = [
  { key: "pending", label: "Pending", status: "NEW,QUALIFIED", hint: "Not yet contacted" },
  { key: "contacted", label: "Contacted", status: "CONTACTED,FOLLOW_UP", hint: "Sent, awaiting a reply" },
  { key: "replied", label: "Replied", status: "REPLIED", hint: "They answered — your move" },
  { key: "all", label: "All", status: "", hint: "Everything active" },
];

function LeadsTab({ productId, product, activeRun, onOpenTab }) {
  const navigate = useNavigate();
  const grid = useServerGrid({
    initialSort: "created",
    initialPageSize: 25,
    initialFilters: { status: "NEW,QUALIFIED" },
    scope: productId,
  });

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // Set only by "select all matching", which knows the reachability of leads no
  // page has rendered. Any manual tick drops it and the derived count takes over.
  const [serverMeta, setServerMeta] = useState(null);
  const [selectingAll, setSelectingAll] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [composeFor, setComposeFor] = useState(null);
  const [evidenceFor, setEvidenceFor] = useState(null);

  // Every lead this tab has rendered, so the bulk bar can describe a selection
  // spanning pages without refetching the ones already scrolled past.
  const seen = useRef(new Map());

  const requestParams = useMemo(() => ({ productId, ...grid.params }), [productId, grid.params]);
  // The same filters minus the paging: what "matching leads" means to the tab
  // counts and to select-all, neither of which is limited to the page on screen.
  const matchParams = useMemo(() => {
    const { page: _page, pageSize: _pageSize, ...rest } = requestParams;
    return rest;
  }, [requestParams]);

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["promoter-leads", productId, grid.queryKey],
    queryFn: () => api.listLeads(requestParams),
    // Keep the previous page rendered during a page flip so ticked selections
    // visibly carry across pages instead of the grid blinking away.
    placeholderData: keepPreviousData,
  });

  const { data: counts } = useQuery({
    queryKey: ["lead-status-counts", { ...matchParams, status: undefined }],
    queryFn: () => api.leadStatusCounts({ ...matchParams, status: undefined }),
    staleTime: 15_000,
  });

  // Built from the countries leads actually have. The list spans every lead in
  // the app rather than this product's, which is fine as an option source —
  // picking one this product has nothing in returns no rows, and the filtered
  // empty state says exactly that.
  const { data: countryData } = useQuery({
    queryKey: ["lead-countries"],
    queryFn: api.listLeadCountries,
    staleTime: 60_000,
  });

  const rows = useMemo(() => data?.leads || [], [data]);
  useEffect(() => { rows.forEach((lead) => seen.current.set(lead.id, lead)); }, [rows]);

  const clearSelection = useCallback(() => { setSelectedIds(new Set()); setServerMeta(null); }, []);
  // A different filter is a different result set; carrying ticks across it
  // would send messages to leads the user can no longer see.
  useEffect(() => { clearSelection(); }, [grid.queryKey, clearSelection]);

  const derivedMeta = useMemo(() => {
    const meta = { withEmail: 0, withPhone: 0, withWhatsApp: 0, emailBlocked: 0, blockedCountries: [] };
    const countries = new Set();
    for (const id of selectedIds) {
      const lead = seen.current.get(id);
      if (!lead) continue;
      if (lead.contact?.hasEmail) meta.withEmail += 1;
      if (lead.contact?.hasPhone) meta.withPhone += 1;
      // Distinct from hasPhone: a switchboard is a phone number but not a
      // WhatsApp account, and the bulk bar must not promise otherwise.
      if (lead.contact?.hasWhatsApp) meta.withWhatsApp += 1;
      // Leads a campaign will refuse on legal grounds, counted as they are
      // ticked so the warning appears before the sheet opens, not after.
      if (lead.compliance?.email?.policy === "BLOCKED") {
        meta.emailBlocked += 1;
        if (lead.compliance.email.country) countries.add(lead.compliance.email.country);
      }
    }
    meta.blockedCountries = [...countries];
    return meta;
  }, [selectedIds]);

  const selectionMeta = serverMeta || derivedMeta;

  // The grid speaks in arrays; the selection is held as a Set because it is
  // membership-tested per row and can hold 500 ids after "select all matching".
  const selectedIdList = useMemo(() => [...selectedIds], [selectedIds]);

  const handleSelectionChange = (next) => {
    setSelectedIds(new Set(next || []));
    setServerMeta(null);
  };

  // "Select all N matching" pulls the full id list (capped at 500 — the same
  // cap a campaign has) so bulk send is one click, not thirteen pages of ticks.
  const selectAllMatching = async () => {
    setSelectingAll(true);
    try {
      const res = await api.listLeadIds(matchParams);
      setSelectedIds(new Set(res.ids));
      setServerMeta({
        withEmail: res.withEmail ?? 0,
        withPhone: res.withPhone ?? 0,
        withWhatsApp: res.withWhatsApp ?? 0,
        emailBlocked: res.emailBlocked ?? 0,
        blockedCountries: res.blockedCountries ?? [],
      });
      if (res.capped) toast.info("Selection capped at 500 leads — the campaign limit.");
      else toast.success(`${res.ids.length} ${res.ids.length === 1 ? "lead" : "leads"} selected.`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSelectingAll(false);
    }
  };

  /**
   * One lead, in the composer that owns both channels. The composer reads
   * `{ value }` cells while a lead card carries plain strings, so they are
   * translated here — otherwise the To: line and the WhatsApp number open blank
   * and have to be retyped from the row the user just clicked.
   */
  const openComposer = useCallback((lead, channel = "EMAIL") => setComposeFor({
    leadId: lead.id,
    channel,
    name: lead.company.name,
    contacts: {
      email: lead.contact?.email ? { value: lead.contact.email } : null,
      phone: lead.contact?.phone ? { value: lead.contact.phone } : null,
      whatsapp: lead.contact?.whatsapp?.number ? { value: lead.contact.whatsapp.number } : null,
    },
  }), []);

  const columns = useMemo(
    () => leadColumns({ onCompose: openComposer, onEvidence: setEvidenceFor }),
    [openComposer],
  );

  const total = data?.total ?? 0;
  const activeStage = PIPELINE.find((p) => (p.status || "") === (grid.filters.status || ""))?.key ?? null;

  // Which empty state an empty grid deserves. The pipeline tab is itself a
  // status filter, so `grid.hasActiveFilters` is true from the first render —
  // and a product that has simply never run a search would be told its filters
  // are too tight. It only counts as narrowed once the user has touched
  // something beyond the tab, or once we know leads exist in another stage.
  const narrowed = grid.debouncedSearch !== ""
    || Object.keys(grid.filters).some((key) => key !== "status")
    || (counts?.all ?? 0) > 0;

  return (
    <PageBody className={cn("space-y-4", selectedIds.size > 0 && "pb-32 md:pb-24")}>
      {product.status === "ARCHIVED" && <ArchivedNotice />}

      {/* A running search is worth a line here, not the whole step list. The
          full panel is twenty rows tall and pushed the leads — the reason this
          tab exists — below the fold; it lives on the Runs tab instead. */}
      {activeRun && (
        <Surface className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <span className="flex items-center gap-2 text-[13px]">
            <Spinner size={13} className="text-[var(--accent)]" />
            <span className="font-medium">Searching for new leads…</span>
            <span className="text-[var(--text-muted)]">Results appear here as they are confirmed.</span>
          </span>
          <Button variant="secondary" size="sm" onClick={() => onOpenTab("runs")}>
            See progress
          </Button>
        </Surface>
      )}

      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Pipeline stage">
        {PIPELINE.map((stage) => (
          <button
            key={stage.key}
            type="button"
            role="tab"
            aria-selected={activeStage === stage.key}
            title={stage.hint}
            onClick={() => grid.setFilter("status", stage.status)}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-[13px] font-medium transition-colors",
              activeStage === stage.key
                ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]",
            )}
          >
            {stage.label}
            {counts?.[stage.key] !== undefined && (
              <span className={cn(
                "tnum rounded-md px-1.5 py-px text-[11px]",
                activeStage === stage.key ? "bg-[color-mix(in_oklch,var(--accent)_18%,transparent)]" : "bg-[var(--surface-sunken)]",
              )}>
                {counts[stage.key]}
              </span>
            )}
          </button>
        ))}
      </div>

      <LeadFilterBar grid={grid} countryData={countryData} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-[var(--text-muted)]">
          <span className="tnum font-semibold text-[var(--text)]">{total}</span> {total === 1 ? "lead" : "leads"}
          {grid.hasActiveFilters && " matching"}
        </p>
        {total > 0 && (
          <button
            type="button"
            onClick={selectAllMatching}
            disabled={selectingAll}
            className="inline-flex items-center gap-1.5 text-[13px] text-[var(--accent)] hover:underline disabled:opacity-50"
          >
            <CheckSquare size={13} />
            {selectingAll ? "Selecting…" : `Select all ${Math.min(total, 500)} matching`}
          </button>
        )}
      </div>

      <DataGrid
        {...grid.bind(total)}
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        loading={isPending}
        error={isError ? error : null}
        onRetry={refetch}
        hasActiveFilters={narrowed}
        emptyFiltered={
          <EmptyState
            icon={Search}
            title="No leads match these filters"
            description="Loosen one, or switch pipeline stage — this product may simply have nothing in that country or above that score yet."
            action={<Button variant="secondary" size="sm" onClick={grid.clearFilters}>Clear filters</Button>}
          />
        }
        empty={
          <EmptyState
            icon={Users}
            title="No leads for this product yet"
            description={
              product.icpApprovedAt
                ? "The profile is approved. Run a search and matching companies land here."
                : "Approve the customer profile first — nothing is searched until you do."
            }
            action={
              <Button size="sm" onClick={() => onOpenTab(product.icpApprovedAt ? "runs" : "profile")}>
                {product.icpApprovedAt
                  ? <><Radar size={13} />Go to runs</>
                  : <><ShieldCheck size={13} />Review the profile</>}
              </Button>
            }
          />
        }
        selectable
        selectedIds={selectedIdList}
        onSelectionChange={handleSelectionChange}
        onRowClick={(row) => navigate(`/leads/${row.id}`)}
        minWidth={1120}
        stickyHeader
      />

      {selectedIds.size > 0 && (
        <BulkBar
          count={selectedIds.size}
          meta={selectionMeta}
          onSend={(channels) => setSheet({ channels })}
          onClear={clearSelection}
        />
      )}

      <BulkSendSheet
        open={Boolean(sheet)}
        onClose={() => setSheet(null)}
        initialChannels={sheet?.channels || ["EMAIL"]}
        selection={{ ids: selectedIdList, ...selectionMeta }}
      />

      {composeFor && (
        <EmailComposer
          leadId={composeFor.leadId}
          name={composeFor.name}
          contacts={composeFor.contacts}
          initialChannel={composeFor.channel}
          onClose={() => setComposeFor(null)}
        />
      )}

      <ProvenanceDrawer
        leadId={evidenceFor?.id}
        companyName={evidenceFor?.company?.name}
        open={Boolean(evidenceFor)}
        onClose={() => setEvidenceFor(null)}
      />
    </PageBody>
  );
}

/**
 * The grid's columns.
 *
 * Only score and freshness are sortable, because those are the only orderings
 * the API has. A sortable header the server cannot honour returns the same rows
 * in the same order and reads as a broken control.
 */
const leadColumns = ({ onCompose, onEvidence }) => [
  {
    key: "score",
    label: "Score",
    width: "80px",
    align: "center",
    sortable: true,
    sortValue: "score",
    render: (row) => (
      <span className="tnum text-[15px] font-semibold" style={{ color: scoreTone(row.score) }}>{row.score}</span>
    ),
  },
  {
    key: "company",
    label: "Company",
    width: "290px",
    render: (row) => (
      <div className="min-w-0">
        {/* No opportunity badge here. It carries the agency service the scoring
            engine inferred — "Website development" on every row — which is a
            different sale from the product this page is promoting, and saying
            it beside the company name reads as what we intend to sell them. */}
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-[var(--text)]">{row.company.name}</span>
        </div>
        <p className="truncate text-[11px] text-[var(--text-subtle)]">
          {[row.company.industry, row.company.city, row.company.countryCode].filter(Boolean).join(" · ") || "—"}
        </p>
        {row.company.domain && (
          <span className="mt-0.5 flex min-w-0 items-center gap-1">
            <span className="truncate font-mono text-[11px] text-[var(--text-muted)]">{row.company.domain}</span>
            {/* A website we could not tie to this business is the one thing
                worth interrupting the scan for — every contact detail taken
                from it may belong to somebody else. */}
            {row.company.domainIdentityStatus === "WEAK" && (
              <span
                className="inline-flex shrink-0 items-center text-[var(--color-caution)]"
                title="This site never identifies itself as this business. Verify before contacting."
              >
                <ShieldAlert size={11} aria-hidden="true" />
                <span className="sr-only">Website ownership unverified</span>
              </span>
            )}
          </span>
        )}
      </div>
    ),
  },
  {
    key: "why",
    label: "Why it matched",
    width: "260px",
    render: (row) => (
      row.topReasons?.length
        ? (
          <ul className="space-y-0.5">
            {row.topReasons.slice(0, 2).map((reason, i) => (
              <li key={`${row.id}-reason-${i}`} className="line-clamp-2 text-[12px] leading-snug text-[var(--text-muted)]">
                {reason.text}
              </li>
            ))}
          </ul>
        )
        : (
          // With the website diagnostics stripped out, most leads have no
          // recorded reason left — they were found because the approved profile
          // asked for this kind of business in this market, which is true and
          // worth saying rather than showing a dash.
          <span className="text-[12px] leading-snug text-[var(--text-subtle)]">
            Matches your profile{row.company?.industry ? ` — ${row.company.industry.split("/")[0].trim().toLowerCase()}` : ""}
            {row.company?.city ? ` in ${row.company.city}` : ""}
          </span>
        )
    ),
  },
  {
    key: "contact",
    label: "Contact",
    width: "230px",
    render: (row) => (
      <div className="min-w-0 space-y-0.5">
        {row.contact?.personName && (
          <p
            className="flex min-w-0 items-center gap-1.5 text-[12px]"
            title={[row.contact.personName, row.contact.personTitle].filter(Boolean).join(" — ")}
          >
            <User size={11} className="shrink-0 text-[var(--accent)]" />
            <span className="truncate">{row.contact.personName}</span>
          </p>
        )}
        {row.contact?.email && (
          <p className="flex min-w-0 items-center gap-1.5" title={row.contact.email}>
            <Mail size={11} className="shrink-0 text-[var(--color-positive)]" />
            <span className="truncate font-mono text-[11px] text-[var(--text-muted)]">{row.contact.email}</span>
          </p>
        )}
        {(row.contact?.phone || row.contact?.hasWhatsApp) && (
          <p className="flex flex-wrap items-center gap-x-3 text-[11px] text-[var(--text-muted)]">
            {row.contact.phone && (
              <span className="inline-flex items-center gap-1">
                <Phone size={11} className="text-[var(--color-positive)]" />{row.contact.phone}
              </span>
            )}
            {row.contact.hasWhatsApp && (
              <span
                className="inline-flex items-center gap-1 text-[var(--color-positive)]"
                title={row.contact.whatsapp?.display || "Reachable on WhatsApp"}
              >
                <MessageCircle size={11} />WhatsApp
              </span>
            )}
          </p>
        )}
        {!row.contact?.hasEmail && !row.contact?.hasPhone && (
          <p className="text-[11px] text-[var(--text-subtle)]">No contact route found</p>
        )}
        {/* The legal position, stated beside the address rather than behind a
            click: in the opt-in markets a single cold email is actionable by
            the recipient with no regulator involved. */}
        {row.compliance?.email?.policy === "BLOCKED" && (
          <p
            className="inline-flex items-center gap-1 text-[10px] font-medium text-[var(--color-critical)]"
            title={row.compliance.email.note}
          >
            <ShieldAlert size={10} />
            Email not lawful{row.compliance.email.law ? ` (${row.compliance.email.law})` : ""}
          </p>
        )}
      </div>
    ),
  },
  {
    key: "status",
    label: "Status",
    width: "130px",
    render: (row) => <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABELS[row.status] || row.status}</Badge>,
  },
  {
    key: "freshness",
    label: "Evidence",
    width: "130px",
    sortable: true,
    sortValue: "freshness",
    render: (row) => (
      <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: freshnessTone(row.freshness?.bucket) }}>
        <span className="size-1.5 rounded-full" style={{ background: freshnessTone(row.freshness?.bucket) }} />
        {row.freshness?.relative || "—"}
      </span>
    ),
  },
  {
    key: "actions",
    label: "Actions",
    width: "132px",
    align: "right",
    headerClass: "sr-only",
    // Clicking an action must not also open the lead's page behind the panel
    // that action just opened.
    render: (row) => (
      <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onCompose(row)}
          title={`Write to ${row.company.name}`}
          aria-label={`Write to ${row.company.name}`}
        >
          <Mail size={13} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onCompose(row, "WHATSAPP")}
          disabled={!row.contact?.hasWhatsApp}
          title={row.contact?.hasWhatsApp
            ? `Message ${row.company.name} on WhatsApp`
            : "No WhatsApp number for this lead"}
          aria-label={`Message ${row.company.name} on WhatsApp`}
        >
          <MessageCircle size={13} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onEvidence(row)}
          title={`Every source behind ${row.company.name}, in the order it was collected`}
          aria-label={`Evidence for ${row.company.name}`}
        >
          <FileSearch size={13} />
        </Button>
      </div>
    ),
  },
];

/**
 * The filter bar.
 *
 * Search grows and the selects stay fixed, so the row does not reflow as values
 * change; every select says what "no choice" means rather than showing a blank
 * first option; and Clear exists only when there is something to clear.
 */
function LeadFilterBar({ grid, countryData }) {
  // `useServerGrid` stores filters as strings, so the multi-select's array is
  // kept as the comma list the API already expects and split back for display.
  const countries = (grid.filters.country || "").split(",").filter(Boolean);

  const countryOptions = [
    ...(countryData?.countries || []).map((c) => ({ value: c.code, label: c.name, hint: c.leadCount })),
    ...(countryData?.unknown
      ? [{ value: "UNKNOWN", label: countryData.unknown.name, hint: countryData.unknown.leadCount }]
      : []),
  ];

  return (
    <Surface className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-sm font-medium">
          <SlidersHorizontal size={14} className="text-[var(--text-subtle)]" />Filters
        </span>
        {grid.hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={grid.clearFilters}>
            <X size={12} />Clear
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[200px] max-w-md flex-1 flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Search</span>
          <span className="relative block">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-subtle)]" />
            {/* Bound to the immediate value so typing feels instant; the hook
                debounces what actually reaches the API. */}
            <Input
              value={grid.search}
              onChange={(e) => grid.setSearch(e.target.value)}
              placeholder="Search company or domain"
              className="py-1.5 pl-8 text-[13px]"
            />
          </span>
        </label>

        <FilterSelect
          label="Status"
          value={grid.filters.status || ""}
          onChange={(v) => grid.setFilter("status", v)}
          options={[
            { value: "", label: "All active" },
            ...Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
          ]}
        />
        <FilterSelect
          label="Opportunity"
          value={grid.filters.service || ""}
          onChange={(v) => grid.setFilter("service", v)}
          options={[
            { value: "", label: "Any" },
            ...Object.entries(SERVICE_LABELS).map(([value, label]) => ({ value, label })),
          ]}
        />
        <FilterSelect
          label="Min score"
          value={grid.filters.minScore || ""}
          onChange={(v) => grid.setFilter("minScore", v)}
          options={[
            { value: "", label: "Any" },
            { value: "40", label: "40+" }, { value: "55", label: "55+" },
            { value: "70", label: "70+" }, { value: "85", label: "85+" },
          ]}
        />
        <FilterSelect
          label="Freshness"
          value={grid.filters.freshness || ""}
          onChange={(v) => grid.setFilter("freshness", v)}
          options={[
            { value: "", label: "Any time" },
            ...Object.entries(FRESHNESS_LABELS).map(([value, label]) => ({ value, label })),
          ]}
        />
        <FilterSelect
          label="Sort by"
          value={grid.sort || "created"}
          onChange={grid.setSort}
          options={[
            { value: "created", label: "Newest first" },
            { value: "score", label: "Score" },
            { value: "freshness", label: "Freshest evidence" },
          ]}
        />

        <div className="flex w-[170px] shrink-0 flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">Country</span>
          <MultiSelect
            value={countries}
            onChange={(next) => grid.setFilter("country", next.join(","))}
            options={countryOptions}
            placeholder="All countries"
            summaryNoun="countries"
            className="px-2.5 py-1.5 text-[13px]"
          />
        </div>

        <label className="flex w-[150px] shrink-0 flex-col gap-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">City</span>
          <Input
            value={grid.filters.city || ""}
            onChange={(e) => grid.setFilter("city", e.target.value)}
            placeholder="Any city"
            className="py-1.5 text-[13px]"
          />
        </label>
      </div>
    </Surface>
  );
}

const FilterSelect = ({ label, value, onChange, options }) => (
  <label className="flex w-[150px] shrink-0 flex-col gap-1">
    <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">{label}</span>
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="py-1.5 text-[13px]">
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Select>
  </label>
);

/**
 * Bulk actions, floating above the mobile tab bar.
 *
 * The full-width wrapper must not eat clicks meant for the pagination behind
 * it, so only the pill itself accepts pointer events.
 */
const BulkBar = ({ count, meta, onSend, onClear }) => (
  <div className="pointer-events-none fixed inset-x-0 bottom-16 z-40 flex justify-center px-4 md:bottom-5 md:pl-60">
    <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-raised)] px-4 py-2.5 shadow-[var(--shadow-lg)]">
      <Badge tone="var(--accent)">{count} selected</Badge>
      <span className="hidden text-[11px] text-[var(--text-subtle)] sm:inline">
        {meta.withEmail} with email · {meta.withWhatsApp} reachable on WhatsApp · kept across pages
      </span>
      {meta.emailBlocked > 0 && (
        <span
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
          style={{
            backgroundColor: "color-mix(in oklch, var(--color-critical) 12%, transparent)",
            color: "var(--color-critical)",
          }}
          title={`Cold email is not lawful in ${meta.blockedCountries.join(", ") || "these markets"}. These leads will be skipped; phone and WhatsApp may still be open.`}
        >
          <ShieldAlert size={11} />
          {meta.emailBlocked} cannot be emailed
        </span>
      )}
      <span className="mx-1 hidden h-4 w-px bg-[var(--border)] sm:inline" />
      <Button size="sm" onClick={() => onSend(["EMAIL"])}><Mail size={13} />Email</Button>
      <Button size="sm" variant="secondary" onClick={() => onSend(["WHATSAPP"])}><MessageCircle size={13} />WhatsApp</Button>
      <Button size="sm" variant="secondary" onClick={() => onSend(["EMAIL", "WHATSAPP"])}>Both</Button>
      <Button size="sm" variant="ghost" onClick={onClear} aria-label="Clear selection"><X size={13} /></Button>
    </div>
  </div>
);

/* ── 4. Runs tab ─────────────────────────────────────────────────────────── */

function RunsTab({ product, runs, activeRun, dirty, onLaunch, launching, onOpenTab }) {
  const approved = Boolean(product.icpApprovedAt);
  const archived = product.status === "ARCHIVED";

  return (
    <PageBody className="space-y-4">
      {archived && <ArchivedNotice />}
      {activeRun && <DiscoveryProgress runId={activeRun.runId} onFinished={() => onOpenTab("leads")} />}

      <Surface className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <Radar size={14} className="text-[var(--accent)]" />Find leads
            </h2>
            <p className="mt-0.5 max-w-xl text-xs text-[var(--text-muted)]">
              {!approved
                ? "The customer profile has not been approved yet, so there is nothing to search on."
                : dirty
                  ? "You have unsaved profile changes. Approve them first, or this run will use the last approved version."
                  : "Searches public sources for companies matching your approved profile. Nothing is emailed automatically."}
            </p>
          </div>

          {archived ? null : approved ? (
            <Button onClick={onLaunch} disabled={launching || Boolean(activeRun)}>
              {launching ? <Spinner size={13} /> : <Rocket size={13} />}
              {launching ? "Starting…" : activeRun ? "A run is in progress" : "Find leads"}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => onOpenTab("profile")}>
              <ShieldCheck size={13} />Approve the profile
            </Button>
          )}
        </div>

        {runs.length === 0 ? (
          <p className="px-4 py-4 text-xs text-[var(--text-subtle)] sm:px-5">
            No runs yet. The first one will appear here, and you can come back to any past run later.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {runs.map((run) => (
              <li key={run.runId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
                <span className="flex min-w-0 items-center gap-2">
                  <Clock size={12} className="shrink-0 text-[var(--text-subtle)]" />
                  <span className="text-[13px]">{formatDateTime(run.createdAt)}</span>
                  <Badge tone={runTone(run.status)}>{String(run.status || "unknown").toLowerCase()}</Badge>
                </span>
                <span className="tnum text-[11px] text-[var(--text-muted)]">
                  {run.leadCount ?? 0} leads
                  {run.stats?.companiesFound !== undefined && ` · ${run.stats.companiesFound} companies seen`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Surface>

      {runs.length > 0 && (
        <p className="text-[11px] text-[var(--text-subtle)]">
          Every lead these runs found is in the{" "}
          <button type="button" onClick={() => onOpenTab("leads")} className="text-[var(--accent)] hover:underline">
            Leads
          </button>{" "}
          tab, filterable and ready to write to.
        </p>
      )}
    </PageBody>
  );
}

/* ── 5. Profile & ICP tab ────────────────────────────────────────────────── */

function ProfileTab({ product, form, setForm, dirty, onDiscard, onApprove, saving, onResearch, researching }) {
  const status = product.status;
  const icpEmpty = !product.icp || Object.keys(product.icp).length === 0;
  const approved = Boolean(product.icpApprovedAt);

  return (
    <PageBody className="space-y-4">
      {status === "ARCHIVED" && <ArchivedNotice />}
      {status === "RESEARCHING" && <ResearchingPanel url={product.url} />}

      {status === "FAILED" && (
        <RecoveryPanel
          title="We could not read that site"
          body="The crawler was blocked, the pages had nothing to extract, or the AI step was unavailable. None of that is a dead end — try again, or write the customer profile yourself and carry on."
          onRetry={onResearch}
          retrying={researching}
          onManual={() => setForm((f) => starterForm(f || toForm(product)))}
        />
      )}

      {status !== "RESEARCHING" && form && (
        <>
          {icpEmpty && status !== "FAILED" && (
            <RecoveryPanel
              title="No customer profile was drafted"
              body="The research finished but the AI could not produce an ideal customer profile — usually because the AI step is switched off or out of budget. Run the research again, or fill the profile in yourself below. Either way nothing is searched until you approve it."
              onRetry={onResearch}
              retrying={researching}
              onManual={() => setForm((f) => starterForm(f))}
            />
          )}

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <ProductProfile product={product} />
            <IcpEditor
              form={form}
              setForm={setForm}
              dirty={dirty}
              approved={approved}
              approvedAt={product.icpApprovedAt}
              onDiscard={onDiscard}
              onApprove={onApprove}
              saving={saving}
            />
          </div>
        </>
      )}
    </PageBody>
  );
}

const RESEARCH_STEPS = [
  ["Reading the public pages", "Homepage, pricing, features, customers — whatever the site actually publishes."],
  ["Extracting the product", "What it does, what it costs, what it claims, and the page each fact came from."],
  ["Drafting an ideal customer profile", "Who would buy this, where they are, and what would tell us they need it."],
];

const ResearchingPanel = ({ url }) => (
  <Surface className="overflow-hidden">
    <div className="flex items-start gap-3 border-b border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3">
      <Spinner size={15} className="mt-0.5 text-[var(--accent)]" />
      <div aria-live="polite">
        <p className="text-sm font-semibold">Reading {prettyUrl(url)}</p>
        <p className="text-xs text-[var(--text-muted)]">
          Usually a minute or two. We cannot say how far along it is honestly, so we will not pretend to —
          this page updates itself when there is something to show.
        </p>
      </div>
    </div>

    <ol className="divide-y divide-[var(--border)]">
      {RESEARCH_STEPS.map(([title, detail]) => (
        <li key={title} className="px-4 py-3">
          <p className="text-[13px] font-medium">{title}</p>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">{detail}</p>
        </li>
      ))}
    </ol>

    <div className="space-y-2 border-t border-[var(--border)] p-4">
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  </Surface>
);

const RecoveryPanel = ({ title, body, onRetry, retrying, onManual }) => (
  <Surface className="border-[color-mix(in_oklch,var(--color-caution)_40%,transparent)] p-4">
    <div className="flex items-start gap-3">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--color-caution)]" />
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-[var(--text-muted)]">{body}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={onRetry} disabled={retrying}>
            {retrying ? <Spinner size={12} /> : <RefreshCw size={12} />}
            {retrying ? "Starting…" : "Try research again"}
          </Button>
          <Button variant="ghost" size="sm" onClick={onManual}>
            <PenLine size={12} />Fill it in myself
          </Button>
        </div>
      </div>
    </div>
  </Surface>
);

/* ── 5a. Left column: what we found ──────────────────────────────────────── */

const ProvenanceList = ({ items, empty }) => {
  if (!items?.length) return <p className="text-xs text-[var(--text-subtle)]">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((item, index) => (
        <li key={`${item.value}-${index}`} className="flex items-start gap-1.5 text-[13px] leading-snug text-[var(--text)]">
          <span className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--text-subtle)]" aria-hidden />
          <span className="min-w-0 flex-1">{item.value}</span>
          <SourceLink href={item.sourceUrl} />
        </li>
      ))}
    </ul>
  );
};

const ProfileBlock = ({ icon: Icon, title, children }) => (
  <section className="border-t border-[var(--border)] px-4 py-4 first:border-t-0 sm:px-5">
    <h3 className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
      <Icon size={13} />{title}
    </h3>
    {children}
  </section>
);

function ProductProfile({ product }) {
  const chips = useMemo(() => (product.features || []).slice(0, 24), [product.features]);
  const pricing = useMemo(() => product.pricing || [], [product.pricing]);

  return (
    <Surface className="overflow-hidden">
      <div className="border-b border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3 sm:px-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Sparkles size={14} className="text-[var(--accent)]" />What we found on your site
        </h2>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          Read-only. Every item links back to the page it came from, so you can check anything that looks wrong before you approve.
        </p>
      </div>

      <ProfileBlock icon={Quote} title="Summary">
        {product.summary
          ? <p className="text-[13px] leading-relaxed text-[var(--text)]">{product.summary}</p>
          : <p className="text-xs text-[var(--text-subtle)]">The pages did not say clearly enough to summarise.</p>}
        {product.category && (
          <div className="mt-2"><Badge tone="var(--color-info)">{product.category}</Badge></div>
        )}
      </ProfileBlock>

      <ProfileBlock icon={ListChecks} title="Features">
        {chips.length === 0
          ? <p className="text-xs text-[var(--text-subtle)]">No features were listed on the pages we read.</p>
          : (
            <ul className="flex flex-wrap gap-1.5">
              {chips.map((feature, index) => (
                <li key={`${feature.value}-${index}`}>
                  <span className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] px-2 py-1 text-[11px]">
                    {feature.value}
                    <SourceLink href={feature.sourceUrl} />
                  </span>
                </li>
              ))}
            </ul>
          )}
      </ProfileBlock>

      <ProfileBlock icon={Coins} title="Pricing">
        {pricing.length === 0
          ? <p className="text-xs text-[var(--text-subtle)]">No public pricing was found.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[22rem] text-left text-[12px]">
                <thead>
                  <tr className="border-b border-[var(--border)] text-[10px] uppercase tracking-wide text-[var(--text-subtle)]">
                    <th className="py-1.5 pr-3 font-medium">Plan</th>
                    <th className="py-1.5 pr-3 font-medium">Price</th>
                    <th className="py-1.5 pr-3 font-medium">Includes</th>
                    <th className="py-1.5 font-medium"><span className="sr-only">Source</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {pricing.map((row, index) => (
                    <tr key={`${row.plan}-${index}`}>
                      <td className="py-1.5 pr-3 font-medium">{row.plan || "—"}</td>
                      <td className="tnum py-1.5 pr-3">{row.price || "—"}</td>
                      <td className="py-1.5 pr-3 text-[var(--text-muted)]">{row.capacity || "—"}</td>
                      <td className="py-1.5"><SourceLink href={row.sourceUrl} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </ProfileBlock>

      <ProfileBlock icon={Target} title="What makes it different">
        <ProvenanceList items={product.differentiators} empty="Nothing on the site set it apart explicitly." />
      </ProfileBlock>

      <ProfileBlock icon={ShieldCheck} title="Proof">
        <ProvenanceList items={product.proofPoints} empty="No customer names, numbers or testimonials were published." />
      </ProfileBlock>

      <ProfileBlock icon={Swords} title="Competitors named">
        <ProvenanceList items={product.competitors} empty="The site did not name anyone it competes with." />
      </ProfileBlock>

      <ProfileBlock icon={MapPin} title="Where it points">
        <ProvenanceList items={product.geographyCues} empty="Nothing on the site hinted at a particular market." />
      </ProfileBlock>

      {(product.researchedUrls?.length > 0 || product.aiUsage) && (
        <div className="border-t border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3 sm:px-5">
          {product.researchedUrls?.length > 0 && (
            <details>
              <summary className="cursor-pointer text-[11px] text-[var(--text-muted)] marker:text-[var(--text-subtle)]">
                {product.researchedUrls.length} pages read
              </summary>
              <ul className="mt-2 space-y-1">
                {product.researchedUrls.map((url) => (
                  <li key={url} className="truncate">
                    <a href={url} target="_blank" rel="noopener noreferrer"
                       className="font-mono text-[11px] text-[var(--accent)] hover:underline">
                      {prettyUrl(url)}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {product.aiUsage && (
            <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-[var(--text-subtle)]">
              <Wallet size={10} />
              {product.aiUsage.calls} AI calls
              {product.aiUsage.estCostUsd !== undefined && ` · $${Number(product.aiUsage.estCostUsd).toFixed(3)}`}
              {product.model && ` · ${product.model}`}
            </p>
          )}
        </div>
      )}
    </Surface>
  );
}

/* ── 5b. Reusable editors — built once, used by nine ICP sections ────────── */

/**
 * A list of short strings entered one at a time.
 *
 * Industries, job titles, disqualifiers and competitors are all the same
 * interaction, so they are all this component. Enter adds; Backspace on an
 * empty box removes the last chip, which is what anyone who has used a
 * to/cc field expects.
 */
const TagListField = ({ label, help, values, onChange, placeholder, max, maxLength }) => {
  const [draft, setDraft] = useState("");

  const full = values.length >= max;
  const over = values.length > max;

  const add = () => {
    const value = draft.trim();
    if (!value || full) return;
    if (values.some((v) => v.toLowerCase() === value.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...values, value]);
    setDraft("");
  };

  const remove = (index) => onChange(values.filter((_, i) => i !== index));

  return (
    <FormField
      label={label}
      hint={`${values.length}/${max}`}
      help={full && !over ? `That is the maximum of ${max}. Remove one to add another.` : help}
      error={over ? `Only ${max} are kept — remove ${values.length - max} before approving.` : undefined}
    >
      {(controlProps) => (
        <div className="flex flex-col gap-2">
          {values.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {values.map((value, index) => (
                <li key={`${value}-${index}`}>
                  <span className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-sunken)] py-1 pl-2 pr-1 text-xs text-[var(--text)]">
                    <span className="max-w-[16rem] truncate">{value}</span>
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      aria-label={`Remove ${value}`}
                      className="rounded p-0.5 text-[var(--text-subtle)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--color-critical)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)]"
                    >
                      <X size={11} />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            <Input
              {...controlProps}
              value={draft}
              maxLength={maxLength}
              disabled={full}
              placeholder={full ? "" : placeholder}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); add(); }
                if (e.key === "Backspace" && !draft && values.length) remove(values.length - 1);
              }}
            />
            <Button type="button" variant="secondary" size="sm" onClick={add} disabled={full || !draft.trim()}>
              <Plus size={12} />Add
            </Button>
          </div>
        </div>
      )}
    </FormField>
  );
};

/**
 * A repeatable group of fields.
 *
 * `children` is a render prop given the row and a patch function, so each
 * section only writes its own inputs — the add/remove/empty plumbing lives
 * here once.
 */
const RepeatableRows = ({ rows, onChange, blank, addLabel, emptyHint, describe, max, children }) => {
  const patch = (id, changes) => onChange(rows.map((r) => (r._id === id ? { ...r, ...changes } : r)));
  const remove = (id) => onChange(rows.filter((r) => r._id !== id));
  const add = () => onChange([...rows, { ...blank, _id: uid() }]);

  const full = rows.length >= max;
  const over = rows.length > max;

  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 && (
        <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-2.5 text-[11px] leading-snug text-[var(--text-subtle)]">
          {emptyHint}
        </p>
      )}

      {rows.map((row, index) => (
        <div key={row._id} className="rounded-lg border border-[var(--border)] bg-[var(--surface-sunken)] p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-subtle)]">
              {describe ? describe(index) : `#${index + 1}`}
            </span>
            <button
              type="button"
              onClick={() => remove(row._id)}
              aria-label={`Remove ${describe ? describe(index) : `row ${index + 1}`}`}
              className="rounded p-1 text-[var(--text-subtle)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--color-critical)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_25%,transparent)]"
            >
              <X size={12} />
            </button>
          </div>
          <div className="flex flex-col gap-2.5">{children(row, (changes) => patch(row._id, changes), index)}</div>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={add} disabled={full}>
          <Plus size={12} />{addLabel}
        </Button>
        <span className={cn("tnum text-[11px]", over ? "text-[var(--color-critical)]" : "text-[var(--text-subtle)]")}>
          {over
            ? `${rows.length}/${max} — remove ${rows.length - max} before approving.`
            : full ? `${rows.length}/${max} — that is the maximum.` : `${rows.length}/${max}`}
        </span>
      </div>
    </div>
  );
};

/** A titled block inside the ICP form, so the form reads as sections not a wall. */
const IcpSection = ({ icon: Icon, title, description, children }) => (
  <section className="border-t border-[var(--border)] px-4 py-4 first:border-t-0 sm:px-5">
    <SectionHeading icon={Icon} title={title} description={description} />
    <div className="flex flex-col gap-4">{children}</div>
  </section>
);

/* ── 5c. Form model — the server's ICP shape, plus row ids ───────────────── */

const toForm = (product) => {
  const icp = product?.icp || {};
  const size = icp.companySize || {};
  return {
    name: product?.name || "",
    pitchAngle: product?.pitchAngle || "",
    proofLink: product?.proofLink || "",
    senderContext: product?.senderContext || "",
    icp: {
      summary: icp.summary || "",
      industries: asStrings(icp.industries),
      companySize: {
        min: size.min === null || size.min === undefined ? "" : String(size.min),
        max: size.max === null || size.max === undefined ? "" : String(size.max),
        note: size.note || "",
      },
      geographies: withIds(icp.geographies).map((g) => ({
        region: g.region || "",
        countryCode: (g.countryCode || "").toUpperCase(),
        reason: g.reason || "",
        priority: Number(g.priority) > 0 ? Number(g.priority) : 1,
        _id: g._id,
      })),
      buyerTitles: {
        decisionMakers: asStrings(icp.buyerTitles?.decisionMakers),
        champions: asStrings(icp.buyerTitles?.champions),
      },
      painPoints: withIds(icp.painPoints).map((p) => ({
        pain: p.pain || "", productAnswer: p.productAnswer || "", _id: p._id,
      })),
      buyingSignals: withIds(icp.buyingSignals).map((s) => ({
        signal: s.signal || "",
        detectableVia: DETECTABLE_VIA.some(([v]) => v === s.detectableVia) ? s.detectableVia : "OTHER",
        // Not user-editable — it is how the backend joins a signal to the
        // catalogue. Carried through so an edit never silently drops it.
        signalKey: s.signalKey ?? null,
        _id: s._id,
      })),
      disqualifiers: asStrings(icp.disqualifiers),
      competitorsToDisplace: asStrings(icp.competitorsToDisplace),
      suggestedSearchQueries: withIds(icp.suggestedSearchQueries).map((q) => ({
        label: q.label || "",
        searchInstruction: q.searchInstruction || "",
        expectedSourceTypes: asStrings(q.expectedSourceTypes),
        _id: q._id,
      })),
    },
  };
};

const numberOrNull = (value) => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
};

const toIcpPayload = (form) => ({
  summary: form.icp.summary.trim(),
  industries: form.icp.industries,
  companySize: {
    min: numberOrNull(form.icp.companySize.min),
    max: numberOrNull(form.icp.companySize.max),
    note: form.icp.companySize.note.trim(),
  },
  geographies: stripIds(form.icp.geographies.filter((g) => g.region.trim() || g.countryCode)),
  buyerTitles: form.icp.buyerTitles,
  painPoints: stripIds(form.icp.painPoints.filter((p) => p.pain.trim())),
  buyingSignals: stripIds(form.icp.buyingSignals.filter((s) => s.signal.trim())),
  disqualifiers: form.icp.disqualifiers,
  competitorsToDisplace: form.icp.competitorsToDisplace,
  suggestedSearchQueries: stripIds(
    form.icp.suggestedSearchQueries.filter((q) => q.label.trim() && q.searchInstruction.trim()),
  ).map((q) => ({ ...q, expectedSourceTypes: q.expectedSourceTypes.slice(0, CAPS.sourceTypes) })),
});

/**
 * A blank row in each empty section, for "the AI could not draft this, I will
 * write it". Only ever fills gaps — a half-drafted profile keeps everything it
 * already has, because a recovery action that deletes work is not a recovery.
 */
const seedIfEmpty = (rows, blank) => (rows.length ? rows : [{ ...blank, _id: uid() }]);

const starterForm = (form) => ({
  ...form,
  icp: {
    ...form.icp,
    geographies: seedIfEmpty(form.icp.geographies, { region: "", countryCode: "", reason: "", priority: 1 }),
    painPoints: seedIfEmpty(form.icp.painPoints, { pain: "", productAnswer: "" }),
    buyingSignals: seedIfEmpty(form.icp.buyingSignals, { signal: "", detectableVia: "WEBSITE_CONTENT", signalKey: null }),
    suggestedSearchQueries: seedIfEmpty(form.icp.suggestedSearchQueries, { label: "", searchInstruction: "", expectedSourceTypes: [] }),
  },
});

/* ── 5d. Right column: who we think buys it ─────────────────────────────── */

function IcpEditor({ form, setForm, dirty, approved, approvedAt, onDiscard, onApprove, saving }) {
  const icp = form.icp;
  // Errors stay quiet until the first approve attempt — shouting at someone
  // about an empty field they have not reached yet is just noise.
  const [submitted, setSubmitted] = useState(false);

  const setIcp = (changes) => setForm((f) => ({ ...f, icp: { ...f.icp, ...changes } }));
  const setField = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const errors = useMemo(() => {
    const out = {};
    if (!form.name.trim()) out.name = "Give the product a name — emails and run history use it.";
    else if (form.name.length > LIMITS.name) out.name = `Keep it under ${LIMITS.name} characters.`;
    if (form.pitchAngle.length > LIMITS.pitchAngle) out.pitchAngle = `Keep it under ${LIMITS.pitchAngle} characters.`;
    if (form.senderContext.length > LIMITS.senderContext) out.senderContext = `Keep it under ${LIMITS.senderContext} characters.`;
    if (form.proofLink.trim()) {
      if (form.proofLink.length > LIMITS.proofLink) out.proofLink = `Keep it under ${LIMITS.proofLink} characters.`;
      else if (!isHttpUrl(form.proofLink.trim())) out.proofLink = "That needs to be a full link, starting with https://.";
    }
    const min = numberOrNull(icp.companySize.min);
    const max = numberOrNull(icp.companySize.max);
    if (min !== null && max !== null && min > max) out.companySize = "The smallest company cannot be bigger than the largest.";

    // Anything over a cap would be trimmed by the server without saying so, so
    // it is refused here instead — losing a hand-written pain point silently is
    // worse than being told to pick which one to drop.
    const over = [
      ["industries", icp.industries.length, CAPS.industries],
      ["places", icp.geographies.length, CAPS.geographies],
      ["decision makers", icp.buyerTitles.decisionMakers.length, CAPS.titles],
      ["champions", icp.buyerTitles.champions.length, CAPS.titles],
      ["pains", icp.painPoints.length, CAPS.painPoints],
      ["signals", icp.buyingSignals.length, CAPS.buyingSignals],
      ["disqualifiers", icp.disqualifiers.length, CAPS.disqualifiers],
      ["competitors", icp.competitorsToDisplace.length, CAPS.competitors],
      ["search strategies", icp.suggestedSearchQueries.length, CAPS.strategies],
    ].filter(([, count, cap]) => count > cap);
    if (over.length) {
      out.caps = `Too many ${over.map(([name, count, cap]) => `${name} (${count} of ${cap})`).join(", ")}.`;
    }
    return out;
  }, [form, icp]);

  const strategies = icp.suggestedSearchQueries.filter((q) => q.label.trim() && q.searchInstruction.trim());
  const hasErrors = Object.keys(errors).length > 0;
  const blocker =
    strategies.length === 0
      ? "Add at least one search strategy below — it is the only thing that tells us where to look, so approval stays disabled until there is one."
      : submitted && errors.caps
        ? errors.caps
        : submitted && hasErrors
          ? "Fix the highlighted fields, then approve."
          : null;

  const err = (key) => (submitted ? errors[key] : undefined);

  const handleApprove = () => {
    setSubmitted(true);
    if (hasErrors) {
      toast.error("A few fields need fixing before this can be approved.");
      return;
    }
    onApprove();
  };

  const handleDiscard = () => { setSubmitted(false); onDiscard(); };

  return (
    <div className="flex flex-col gap-3">
      <Surface className="overflow-hidden">
        <div className="border-b border-[var(--border)] bg-[var(--surface-sunken)] px-4 py-3 sm:px-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Users size={14} className="text-[var(--accent)]" />Who we think buys it
          </h2>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">
            A first draft, not a verdict. Everything here is yours to change, and the version you approve is
            the one every search and every email is built from.
          </p>
        </div>

        <IcpSection icon={Quote} title="In one paragraph" description="The short answer to “who is this for?”">
          <FormField
            label="Summary"
            help="Written into the search prompts, so plain and specific beats broad and flattering."
          >
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                value={icp.summary}
                maxLength={CAPS.summary}
                placeholder="Small and mid-sized agencies and outsourcing firms in the Gulf who run payroll across more than one country on spreadsheets."
                onChange={(e) => setIcp({ summary: e.target.value })}
              />
            )}
          </FormField>
        </IcpSection>

        <IcpSection icon={Layers} title="Industries and size" description="The blunt filters — applied before anything clever happens.">
          <TagListField
            label="Industries"
            values={icp.industries}
            onChange={(industries) => setIcp({ industries })}
            placeholder="Recruitment agencies"
            max={CAPS.industries}
            maxLength={CAPS.industryText}
            help="Press Enter to add each one. Broad enough to find companies, narrow enough that the results are not noise."
          />

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Smallest company" hint="headcount" help="Leave blank for no lower limit." error={err("companySize")}>
              {(p) => (
                <Input {...p} type="number" min="0" inputMode="numeric" value={icp.companySize.min}
                  placeholder="5"
                  onChange={(e) => setIcp({ companySize: { ...icp.companySize, min: e.target.value } })} />
              )}
            </FormField>
            <FormField label="Largest company" hint="headcount" help="Leave blank for no upper limit.">
              {(p) => (
                <Input {...p} type="number" min="0" inputMode="numeric" value={icp.companySize.max}
                  placeholder="250"
                  onChange={(e) => setIcp({ companySize: { ...icp.companySize, max: e.target.value } })} />
              )}
            </FormField>
          </div>

          <FormField label="Note on size" help="Anything the two numbers cannot express — “under 50 unless multi-country”, for example.">
            {(p) => (
              <Input {...p} value={icp.companySize.note} maxLength={CAPS.sizeNote}
                placeholder="Under 50 staff unless they operate in more than one country"
                onChange={(e) => setIcp({ companySize: { ...icp.companySize, note: e.target.value } })} />
            )}
          </FormField>
        </IcpSection>

        <IcpSection icon={MapPin} title="Where they are" description="Searched in priority order. Country also decides whether a cold email is lawful at all.">
          <RepeatableRows
            rows={icp.geographies}
            onChange={(geographies) => setIcp({ geographies })}
            blank={{ region: "", countryCode: "", reason: "", priority: 1 }}
            addLabel="Add a place"
            max={CAPS.geographies}
            describe={(i) => `Place ${i + 1}`}
            emptyHint="No geography set — searches will not be restricted by location, which usually means broader and weaker results."
          >
            {(row, patch) => (
              <>
                <div className="grid gap-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <FormField label="Region or city" help="What a person would call it.">
                    {(p) => (
                      <Input {...p} value={row.region} maxLength={CAPS.region} placeholder="Riyadh"
                        onChange={(e) => patch({ region: e.target.value })} />
                    )}
                  </FormField>
                  <FormField label="Country" help="Drives the send-policy check before any email goes out.">
                    {(p) => (
                      <Select {...p} value={row.countryCode} onChange={(e) => patch({ countryCode: e.target.value })}>
                        <option value="">Not set</option>
                        {row.countryCode && !COUNTRY_OPTIONS.some((c) => c.code === row.countryCode) && (
                          <option value={row.countryCode}>{countryLabel(row.countryCode)}</option>
                        )}
                        {COUNTRY_OPTIONS.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                      </Select>
                    )}
                  </FormField>
                </div>
                <FormField label="Why here" help="The evidence for this market — Arabic pages, a currency, a named customer.">
                  {(p) => (
                    <Input {...p} value={row.reason} maxLength={CAPS.reason} placeholder="The site ships an Arabic interface and prices in SAR"
                      onChange={(e) => patch({ reason: e.target.value })} />
                  )}
                </FormField>
                <FormField label="Priority" help="1 is searched first.">
                  {(p) => (
                    <Select {...p} value={row.priority} onChange={(e) => patch({ priority: Number(e.target.value) })}>
                      {PRIORITIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </Select>
                  )}
                </FormField>
              </>
            )}
          </RepeatableRows>
        </IcpSection>

        <IcpSection icon={Users} title="Who to write to" description="Two different jobs: the person who signs, and the person who feels the pain.">
          <TagListField
            label="Decision makers"
            values={icp.buyerTitles.decisionMakers}
            onChange={(decisionMakers) => setIcp({ buyerTitles: { ...icp.buyerTitles, decisionMakers } })}
            placeholder="Founder / CEO"
            max={CAPS.titles}
            maxLength={CAPS.titleText}
            help="Whoever can say yes to the spend."
          />
          <TagListField
            label="Champions"
            values={icp.buyerTitles.champions}
            onChange={(champions) => setIcp({ buyerTitles: { ...icp.buyerTitles, champions } })}
            placeholder="HR manager"
            max={CAPS.titles}
            maxLength={CAPS.titleText}
            help="Whoever lives with the problem daily and will push for it internally."
          />
        </IcpSection>

        <IcpSection icon={Target} title="Pains and answers" description="Each pain is paired with what your product actually does about it — that pairing is what an email leads on.">
          <RepeatableRows
            rows={icp.painPoints}
            onChange={(painPoints) => setIcp({ painPoints })}
            blank={{ pain: "", productAnswer: "" }}
            addLabel="Add a pain"
            max={CAPS.painPoints}
            describe={(i) => `Pain ${i + 1}`}
            emptyHint="No pains listed. Emails will have nothing concrete to open on, and will read like a brochure."
          >
            {(row, patch) => (
              <>
                <FormField label="Their pain" help="In their words, not yours.">
                  {(p) => (
                    <Input {...p} value={row.pain} maxLength={CAPS.painText} placeholder="Payroll for three countries lives in one spreadsheet"
                      onChange={(e) => patch({ pain: e.target.value })} />
                  )}
                </FormField>
                <FormField label="What your product does about it" help="Name the real capability. Anything vague here shows up as waffle in the email.">
                  {(p) => (
                    <Input {...p} value={row.productAnswer} maxLength={CAPS.painText} placeholder="Runs payroll in 20+ currencies on one flat plan"
                      onChange={(e) => patch({ productAnswer: e.target.value })} />
                  )}
                </FormField>
              </>
            )}
          </RepeatableRows>
        </IcpSection>

        <IcpSection icon={Radar} title="Buying signals" description="Things visible from outside a company that suggest they need this now.">
          <RepeatableRows
            rows={icp.buyingSignals}
            onChange={(buyingSignals) => setIcp({ buyingSignals })}
            blank={{ signal: "", detectableVia: "WEBSITE_CONTENT", signalKey: null }}
            addLabel="Add a signal"
            max={CAPS.buyingSignals}
            describe={(i) => `Signal ${i + 1}`}
            emptyHint="No signals. Searches will match on industry and place only, which finds companies but says nothing about timing."
          >
            {(row, patch) => (
              <>
                <FormField label="The signal" help="What would be true of a company that needs this right now.">
                  {(p) => (
                    <Input {...p} value={row.signal} maxLength={CAPS.signalText} placeholder="Hiring an HR or recruitment role in more than one country"
                      onChange={(e) => patch({ signal: e.target.value })} />
                  )}
                </FormField>
                <FormField label="How we would spot it" help="Only pick something genuinely visible from outside — this is what the search actually goes looking for.">
                  {(p) => (
                    <Select {...p} value={row.detectableVia} onChange={(e) => patch({ detectableVia: e.target.value })}>
                      {DETECTABLE_VIA.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </Select>
                  )}
                </FormField>
              </>
            )}
          </RepeatableRows>
        </IcpSection>

        <IcpSection icon={Ban} title="Who to leave alone" description="Exclusions are cheaper than a bad reply.">
          <TagListField
            label="Disqualifiers"
            values={icp.disqualifiers}
            onChange={(disqualifiers) => setIcp({ disqualifiers })}
            placeholder="Already running Workday or SAP"
            max={CAPS.disqualifiers}
            maxLength={CAPS.disqualifierText}
            help="Anything that makes a company a waste of an email, however well it matches otherwise."
          />
          <TagListField
            label="Competitors to displace"
            values={icp.competitorsToDisplace}
            onChange={(competitorsToDisplace) => setIcp({ competitorsToDisplace })}
            placeholder="BambooHR"
            max={CAPS.competitors}
            maxLength={CAPS.competitorText}
            help="Tools a good prospect is likely paying for today. Used to find them, and to frame the switch."
          />
        </IcpSection>

        <IcpSection icon={Compass} title="Search strategies" description="The actual instructions we search on. Without at least one there is nothing to run.">
          <RepeatableRows
            rows={icp.suggestedSearchQueries}
            onChange={(suggestedSearchQueries) => setIcp({ suggestedSearchQueries })}
            blank={{ label: "", searchInstruction: "", expectedSourceTypes: [] }}
            addLabel="Add a strategy"
            max={CAPS.strategies}
            describe={(i) => `Strategy ${i + 1}`}
            emptyHint="Nothing to search on yet. Add at least one strategy — approval is blocked until you do."
          >
            {(row, patch) => (
              <>
                <FormField label="Name it" help="How it appears in the run so you can tell which strategy found what.">
                  {(p) => (
                    <Input {...p} value={row.label} maxLength={CAPS.strategyLabel} placeholder="Gulf agencies hiring HR staff"
                      onChange={(e) => patch({ label: e.target.value })} />
                  )}
                </FormField>
                <FormField label="What to look for" help="Written as an instruction, the way you would brief a researcher.">
                  {(p) => (
                    <Textarea {...p} rows={2} value={row.searchInstruction} maxLength={CAPS.strategyInstruction}
                      placeholder="Find recruitment and outsourcing agencies in Saudi Arabia and the UAE with 5–250 staff that have posted an HR or payroll job in the last 90 days."
                      onChange={(e) => patch({ searchInstruction: e.target.value })} />
                  )}
                </FormField>
                {row.expectedSourceTypes.length > 0 && (
                  <Field label="Expected sources">
                    <span className="text-xs text-[var(--text-muted)]">{row.expectedSourceTypes.join(", ")}</span>
                  </Field>
                )}
              </>
            )}
          </RepeatableRows>
        </IcpSection>

        <IcpSection icon={Mail} title="How emails should sound" description="Used when drafts are written. The lead's own facts stay the only source of personalisation.">
          <FormField label="Product name" error={err("name")} required
            hint={`${form.name.length}/${LIMITS.name}`}
            help="What we call it in the app, in run history and in emails.">
            {(p) => (
              <Input {...p} value={form.name} maxLength={LIMITS.name} placeholder="TracefyHR"
                onChange={(e) => setField("name", e.target.value)} />
            )}
          </FormField>

          <FormField label="Pitch angle" error={err("pitchAngle")}
            hint={`${form.pitchAngle.length}/${LIMITS.pitchAngle}`}
            help="The single value proposition emails may lead with. One claim, stated plainly — not a list.">
            {(p) => (
              <Textarea {...p} rows={2} value={form.pitchAngle} maxLength={LIMITS.pitchAngle}
                placeholder="Payroll, leave and hiring in one place, priced flat instead of per seat."
                onChange={(e) => setField("pitchAngle", e.target.value)} />
            )}
          </FormField>

          <FormField label="Proof link" error={err("proofLink")}
            hint={`${form.proofLink.length}/${LIMITS.proofLink}`}
            help="Used only in follow-ups, never in the first email — a link in a cold opener is what gets it filtered.">
            {(p) => (
              <Input {...p} type="url" inputMode="url" value={form.proofLink} maxLength={LIMITS.proofLink}
                placeholder="https://tracefyhr.com/customers"
                onChange={(e) => setField("proofLink", e.target.value)} />
            )}
          </FormField>

          <FormField label="Sender context" error={err("senderContext")}
            hint={`${form.senderContext.length}/${LIMITS.senderContext}`}
            help="Who is sending and how they relate to the product. Recipients answer people, not products.">
            {(p) => (
              <Textarea {...p} rows={2} value={form.senderContext} maxLength={LIMITS.senderContext}
                placeholder="I build TracefyHR and I am talking to a handful of agencies running multi-country payroll."
                onChange={(e) => setField("senderContext", e.target.value)} />
            )}
          </FormField>
        </IcpSection>
      </Surface>

      {/* Sticky above the mobile tab bar, which owns the bottom 80px there. */}
      <div className="sticky bottom-20 z-20 md:bottom-4">
        <Surface className="border-[var(--border-strong)] p-3 shadow-[var(--shadow-md)] sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">
                {approved ? "This profile is approved and in use." : "Nothing is searched or contacted until you approve this."}
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)]">
                {blocker
                  || (approved && !dirty
                    ? `Approved ${formatDateTime(approvedAt)}. Every search runs on exactly this version — edit it and approve again to change what we look for.`
                    : "The version you approve is what drives every search and every email. Read it once more before you commit to it.")}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {dirty && (
                <Button variant="ghost" size="sm" onClick={handleDiscard} disabled={saving}>Discard edits</Button>
              )}
              <Button
                size="md"
                onClick={handleApprove}
                disabled={saving || strategies.length === 0}
                title={blocker || undefined}
              >
                {saving ? <Spinner size={13} /> : <ShieldCheck size={13} />}
                {saving ? "Saving…" : approved && !dirty ? "Approve again" : "Approve and use this profile"}
              </Button>
            </div>
          </div>
        </Surface>
      </div>
    </div>
  );
}
