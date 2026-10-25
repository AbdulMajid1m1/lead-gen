import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X, Upload, FileSpreadsheet, UserPlus, Check, AlertTriangle, Hand, Bot } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api.js";
import { Button, FormField, Input, Select, Spinner, Textarea } from "./ui.jsx";
import { SERVICE_LABELS, cn } from "../lib/format.js";
import { COUNTRY_OPTIONS } from "../lib/countries.js";

/**
 * Bring leads in by hand: a CSV, cells pasted straight from Excel or Google
 * Sheets, or one company typed into a form.
 *
 * Only the company name is required. Uploaded leads default to Manual, which
 * means LeadSignal never emails or messages them on its own — the person who
 * brought them in decides when (and whether) automation may take over.
 */

const FIELDS = [
  { key: "company", label: "Company", required: true, synonyms: ["company", "company name", "business", "business name", "organisation", "organization", "name", "account"] },
  { key: "website", label: "Website", synonyms: ["website", "site", "url", "domain", "web", "homepage"] },
  { key: "email", label: "Email", synonyms: ["email", "e mail", "email address", "emails", "public email", "mail", "work email"] },
  { key: "phone", label: "Phone", synonyms: ["phone", "telephone", "tel", "mobile", "whatsapp", "phone number", "public phone", "contact number"] },
  { key: "contactName", label: "Contact name", synonyms: ["contact", "contact name", "decision maker", "person", "full name", "contact person", "owner"] },
  { key: "contactTitle", label: "Contact title", synonyms: ["title", "job title", "position", "role", "designation", "decision maker title"] },
  { key: "city", label: "City", synonyms: ["city", "town", "location", "emirate"] },
  { key: "country", label: "Country", synonyms: ["country", "country code", "nation"] },
  { key: "industry", label: "Industry", synonyms: ["industry", "sector", "segment", "category", "vertical"] },
  { key: "size", label: "Size", synonyms: ["size", "employees", "staff", "headcount", "company size", "approx employees", "approx staff", "approx size", "team size"] },
  { key: "hook", label: "Why this lead", synonyms: ["hook", "personal hook", "why", "reason", "opener", "fit evidence", "payroll services evidence", "notes for email"] },
  { key: "notes", label: "Notes", synonyms: ["notes", "note", "comments", "comment", "remarks", "next action"] },
  { key: "sourceUrl", label: "Source link", synonyms: ["source", "source url", "source urls", "evidence url", "hook source url", "email source url", "contact page", "link"] },
];

const MAX_ROWS = 500;
const header = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * A small CSV/TSV reader: quoted fields, doubled quotes, newlines inside
 * quotes. Tab-separated wins when the first line has tabs, which is what a
 * paste from a spreadsheet produces.
 */
const parseTable = (textIn) => {
  const text = String(textIn || "").replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const sep = firstLine.includes("\t") ? "\t" : (firstLine.split(";").length > firstLine.split(",").length ? ";" : ",");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); cell = "";
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
};

/** Which column most likely holds each field, by header name. */
const guessMapping = (headers) => {
  const normalised = headers.map(header);
  const used = new Set();
  const mapping = {};
  // A "contact page" or "decision maker linkedin" column is a link, not the
  // contact's name; only the source field may claim one on a partial match.
  const linky = (h) => /\b(page|url|urls|link|links|source|linkedin|evidence)\b/.test(h);
  for (const field of FIELDS) {
    // Exact synonym first, then "contains" — "company name (legal)" still maps.
    let index = normalised.findIndex((h, i) => !used.has(i) && field.synonyms.includes(h));
    if (index === -1) {
      index = normalised.findIndex((h, i) => !used.has(i)
        && (field.key === "sourceUrl" || !linky(h))
        && field.synonyms.some((s) => s.length > 3 && h.includes(s)));
    }
    if (index !== -1) { mapping[field.key] = index; used.add(index); }
  }
  return mapping;
};

const emptyOne = () => ({ company: "", website: "", email: "", phone: "", contactName: "", contactTitle: "", city: "", country: "", industry: "", size: "", hook: "", notes: "" });

export const ImportLeadsSheet = ({ open, onClose, onImported }) => {
  const queryClient = useQueryClient();
  const fileRef = useRef(null);
  const [mode, setMode] = useState("file"); // file | one
  const [raw, setRaw] = useState("");
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState({});
  const [one, setOne] = useState(emptyOne);
  const [target, setTarget] = useState(""); // "" = agency services, else product id
  const [service, setService] = useState("WEBSITE_DEV");
  const [sendMode, setSendMode] = useState("MANUAL");
  const [label, setLabel] = useState("");
  const [result, setResult] = useState(null);

  const { data: productData } = useQuery({
    queryKey: ["promoted-products"],
    queryFn: () => api.listPromotedProducts(),
    enabled: open,
    staleTime: 60_000,
  });
  const products = (productData?.products || []).filter((p) => p.status !== "ARCHIVED");

  // Default to the first product: in practice uploads are for the product being sold.
  useEffect(() => {
    if (open && !target && products.length) setTarget(products[0].id);
  }, [open, products, target]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [open, onClose]);

  const table = useMemo(() => parseTable(raw), [raw]);
  const headers = table[0] || [];
  const body = table.slice(1);

  useEffect(() => { setMapping(guessMapping(headers)); }, [raw]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    if (mode === "one") return one.company.trim() ? [one] : [];
    if (mapping.company === undefined) return [];
    return body
      .map((cells) => Object.fromEntries(FIELDS.map((f) => [f.key, mapping[f.key] === undefined ? "" : (cells[mapping[f.key]] || "").trim()])))
      .filter((r) => r.company);
  }, [mode, one, body, mapping]);

  const readFile = (file) => {
    if (!file) return;
    if (/\.xlsx?$/i.test(file.name)) {
      toast.error("Excel files can't be read directly. In Excel use File → Save As → CSV, or copy the cells and paste them below.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => { setRaw(String(reader.result || "")); setFileName(file.name); setResult(null); };
    reader.readAsText(file);
  };

  const submit = useMutation({
    mutationFn: () => api.importLeads({
      rows: rows.slice(0, MAX_ROWS),
      sendMode,
      productId: target || null,
      service: target ? null : service,
      label: label.trim() || fileName || null,
    }),
    onSuccess: (data) => {
      setResult(data);
      toast.success(`${data.created} added${data.updated ? `, ${data.updated} updated` : ""}${data.skipped ? `, ${data.skipped} skipped` : ""}.`);
      queryClient.invalidateQueries({ queryKey: ["leads"] });
      queryClient.invalidateQueries({ queryKey: ["lead-status-counts"] });
      queryClient.invalidateQueries({ queryKey: ["lead-countries"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const reset = () => { setRaw(""); setFileName(""); setOne(emptyOne()); setResult(null); };
  const setOneField = (key) => (e) => setOne((o) => ({ ...o, [key]: e.target.value }));

  if (!open) return null;

  const problems = result?.results?.filter((r) => r.outcome === "SKIPPED" || r.warnings?.length) || [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-[var(--scrim)] backdrop-blur-[3px]" onClick={onClose} aria-hidden />
      <aside role="dialog" aria-modal="true" aria-label="Upload leads"
        className="relative flex h-full w-full max-w-2xl flex-col border-l border-[var(--border)] bg-[var(--surface-raised)] shadow-[var(--shadow-lg)]">
        <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Upload leads</h2>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              Only the company name is required. Companies already in the book are updated, not duplicated.
            </p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--surface-sunken)]" aria-label="Close">
            <X size={16} />
          </button>
        </header>

        {result ? (
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
            <div className="grid grid-cols-3 gap-3">
              {[["Added", result.created], ["Updated", result.updated], ["Skipped", result.skipped]].map(([k, v]) => (
                <div key={k} className="rounded-lg border border-[var(--border)] p-3">
                  <p className="tnum text-xl font-semibold">{v}</p>
                  <p className="text-[11px] uppercase tracking-wide text-[var(--text-subtle)]">{k}</p>
                </div>
              ))}
            </div>
            {sendMode === "MANUAL" && result.created + result.updated > 0 && (
              <p className="rounded-lg bg-[var(--accent-soft)] p-3 text-xs text-[var(--text)]">
                These leads are set to <strong>Manual</strong>: nothing is sent to them automatically. Open a lead to write to it yourself, or switch it to Auto when you're ready.
              </p>
            )}
            {problems.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Worth a look</h3>
                <ul className="space-y-1.5 text-xs">
                  {problems.map((r) => (
                    <li key={r.line} className="flex gap-2 rounded-lg border border-[var(--border)] p-2.5">
                      <AlertTriangle size={13} className="mt-px shrink-0 text-[var(--color-caution)]" />
                      <span>
                        <span className="font-medium">Row {r.line}{r.company ? ` · ${r.company}` : ""}:</span>{" "}
                        {r.reason || r.warnings.join(" ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => { onImported?.(result); onClose(); }}><Check size={13} />Show uploaded leads</Button>
              <Button variant="secondary" onClick={reset}>Upload more</Button>
            </div>
          </div>
        ) : (
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); if (rows.length) submit.mutate(); }}>
            <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
              <div className="inline-flex rounded-lg border border-[var(--border)] p-0.5" role="tablist">
                {[["file", FileSpreadsheet, "File or paste"], ["one", UserPlus, "One lead"]].map(([key, Icon, text]) => (
                  <button key={key} type="button" role="tab" aria-selected={mode === key} onClick={() => setMode(key)}
                    className={cn("inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium",
                      mode === key ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--text-muted)] hover:text-[var(--text)]")}>
                    <Icon size={13} />{text}
                  </button>
                ))}
              </div>

              {mode === "file" ? (
                <section className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv" className="sr-only" aria-label="Choose a CSV file"
                      onChange={(e) => readFile(e.target.files?.[0])} />
                    <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>
                      <Upload size={13} />Choose CSV file
                    </Button>
                    <span className="text-xs text-[var(--text-muted)]">{fileName || "or paste rows from Excel / Google Sheets below, header row first"}</span>
                  </div>
                  <Textarea value={raw} onChange={(e) => { setRaw(e.target.value); setFileName(""); }} rows={6}
                    placeholder={"Company\tWebsite\tEmail\tCity\tCountry\nGulf Bridge LLC\tgulfbridge.ae\tinfo@gulfbridge.ae\tDubai\tUAE"}
                    className="font-mono text-[12px]" aria-label="Paste rows" />

                  {headers.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Columns</h3>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {FIELDS.map((f) => (
                          <label key={f.key} className="flex items-center justify-between gap-2 text-xs">
                            <span className={cn(f.required && "font-medium")}>{f.label}{f.required && " *"}</span>
                            <select value={mapping[f.key] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value === "" ? undefined : Number(e.target.value) }))}
                              className="w-44 rounded-md border border-[var(--border-strong)] bg-[var(--surface-raised)] px-2 py-1 text-xs">
                              <option value="">— not in the file —</option>
                              {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                            </select>
                          </label>
                        ))}
                      </div>
                      {mapping.company === undefined && (
                        <p className="text-xs text-[var(--color-critical)]">Pick the column that holds the company name.</p>
                      )}
                      {rows.length > 0 && (
                        <p className="text-xs text-[var(--text-muted)]">
                          {rows.length} {rows.length === 1 ? "company" : "companies"} found
                          {rows.length > MAX_ROWS ? ` — only the first ${MAX_ROWS} will be uploaded` : ""}, e.g. {rows.slice(0, 3).map((r) => r.company).join(", ")}.
                        </p>
                      )}
                    </div>
                  )}
                </section>
              ) : (
                <section className="grid gap-3 sm:grid-cols-2">
                  <FormField label="Company" required className="sm:col-span-2">{(p) => <Input {...p} value={one.company} onChange={setOneField("company")} placeholder="Gulf Bridge LLC" />}</FormField>
                  <FormField label="Website">{(p) => <Input {...p} value={one.website} onChange={setOneField("website")} placeholder="gulfbridge.ae" />}</FormField>
                  <FormField label="Email">{(p) => <Input {...p} type="email" value={one.email} onChange={setOneField("email")} placeholder="info@gulfbridge.ae" />}</FormField>
                  <FormField label="Phone">{(p) => <Input {...p} value={one.phone} onChange={setOneField("phone")} placeholder="+971 4 000 0000" />}</FormField>
                  <FormField label="Contact name">{(p) => <Input {...p} value={one.contactName} onChange={setOneField("contactName")} />}</FormField>
                  <FormField label="Contact title">{(p) => <Input {...p} value={one.contactTitle} onChange={setOneField("contactTitle")} placeholder="HR Manager" />}</FormField>
                  <FormField label="City">{(p) => <Input {...p} value={one.city} onChange={setOneField("city")} />}</FormField>
                  <FormField label="Country">{(p) => (
                    <Select {...p} value={one.country} onChange={setOneField("country")}>
                      <option value="">—</option>
                      {COUNTRY_OPTIONS.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
                    </Select>
                  )}</FormField>
                  <FormField label="Industry">{(p) => <Input {...p} value={one.industry} onChange={setOneField("industry")} />}</FormField>
                  <FormField label="Size" hint="people">{(p) => <Input {...p} value={one.size} onChange={setOneField("size")} placeholder="20-50" />}</FormField>
                  <FormField label="Why this lead" className="sm:col-span-2" help="One true, specific line about them. It becomes a reason on the lead and can open the email.">
                    {(p) => <Input {...p} value={one.hook} onChange={setOneField("hook")} maxLength={500} />}
                  </FormField>
                  <FormField label="Notes" className="sm:col-span-2">{(p) => <Textarea {...p} rows={3} value={one.notes} onChange={setOneField("notes")} maxLength={2000} />}</FormField>
                </section>
              )}

              <section className="space-y-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">How to handle them</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label="Selling">{(p) => (
                    <Select {...p} value={target} onChange={(e) => setTarget(e.target.value)}>
                      {products.map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
                      <option value="">Agency services</option>
                    </Select>
                  )}</FormField>
                  {!target && (
                    <FormField label="Service">{(p) => (
                      <Select {...p} value={service} onChange={(e) => setService(e.target.value)}>
                        {Object.entries(SERVICE_LABELS).filter(([k]) => k !== "SAAS_PRODUCT").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </Select>
                    )}</FormField>
                  )}
                  <FormField label="Name this upload" hint="optional">{(p) => <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={fileName || "UAE agencies, Oct"} maxLength={120} />}</FormField>
                </div>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Sending">
                  {[
                    ["MANUAL", Hand, "Manual", "You send to them. LeadSignal sends nothing automatically until you switch a lead to Auto."],
                    ["AUTO", Bot, "Auto", "Campaigns, autopilot and follow-ups may write to them like any other lead."],
                  ].map(([value, Icon, title, text]) => (
                    <button key={value} type="button" role="radio" aria-checked={sendMode === value} onClick={() => setSendMode(value)}
                      className={cn("rounded-lg border p-3 text-left transition-colors",
                        sendMode === value ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-[var(--border)] hover:border-[var(--border-strong)]")}>
                      <span className="flex items-center gap-1.5 text-[13px] font-medium"><Icon size={13} />{title}</span>
                      <span className="mt-1 block text-[11px] leading-snug text-[var(--text-muted)]">{text}</span>
                    </button>
                  ))}
                </div>
              </section>
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-5 py-4">
              <p className="text-[11px] text-[var(--text-muted)]">
                {rows.length ? `${Math.min(rows.length, MAX_ROWS)} ${rows.length === 1 ? "lead" : "leads"} ready` : "Nothing to upload yet"}
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
                <Button type="submit" disabled={!rows.length || submit.isPending}>
                  {submit.isPending ? <Spinner size={13} /> : <Upload size={13} />}Upload
                </Button>
              </div>
            </footer>
          </form>
        )}
      </aside>
    </div>
  );
};
