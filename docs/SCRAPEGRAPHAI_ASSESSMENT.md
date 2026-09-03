# ScrapeGraphAI — assessment for LeadSignal

_Written 2026-09-03 for the SaaS Promoter and lead-discovery flow. Verdict up front: **skip the open-source library; do not integrate now.** Revisit the hosted API only if an LLM provider with credit is in place and we decide to buy discovery reach rather than build it._

## What it is

[ScrapeGraphAI](https://github.com/ScrapeGraphAI/Scrapegraph-ai) is a Python library (MIT, ~30k stars, actively maintained) that turns "extract X from this page" into an LLM call: it fetches a page with Playwright, hands the text to a model you configure (OpenAI, Gemini, Groq, Azure, or a local Ollama model) and returns structured JSON. Its graph types are `SmartScraperGraph` (one page), `SmartScraperMultiGraph` (many pages), `SearchGraph` (search the web, then scrape the results) and a few generators. There is also a paid hosted API with Python and JS SDKs that adds anti-bot handling.

## How it maps onto what we already have

| Stage in our flow | What we have | What ScrapeGraphAI would add |
|---|---|---|
| Product research (read the SaaS site, extract features/pricing/ICP) | `lib/promoter/productResearch.js`: our own crawler + `parseStructured()` with a citation guard that discards any URL the model cites but we never fetched | The same thing with a different wrapper. It does **not** keep the fetched-URL citation guard, and it would replace a Node module with a Python sidecar. |
| Company discovery (`AI_DISCOVER`) | `lib/research/discover.js`: LLM web search → `AiCandidate` quarantine → existence gate | `SearchGraph` is the closest match. Its search backend is not documented in the README and it returns extracted text, not the provenance (`SourceRecord`, `AiClaim`, `AiCitation`) that `RESOLVE_MERGE → AI_VERIFY` depend on. Everything it found would still have to go through our quarantine. |
| Site crawl + fact extraction (`CRAWL`, `SIGNALS`) | `lib/crawler/*` + deterministic extractors (contacts, people, tech, audits, careers page) with `evidenceSnippet` on every `ExtractedFact` | An LLM extractor per page. More flexible for messy pages, but each page becomes a paid model call, and the output has no snippet-level provenance. |
| Verification | `AI_VERIFY` re-fetches every claimed detail | Nothing; it is an extraction tool, not a verifier. |

## Why it is not a fit today

1. **It needs an LLM key, and ours has no credit.** Every graph run is a model call. The whole reason the promoter's AI stages are being run by hand right now is that `OPENAI_API_KEY` returns `429 no credits` (see the 2026-08-28 note). Adding a second consumer of the same empty budget solves nothing. Ollama would avoid the bill but the prod box is 2 vCPU / 7.8 GB with no GPU, shared with five other projects; a local model there is not realistic.
2. **Language and deployment.** The backend is Node/Prisma in Docker Compose. ScrapeGraphAI is Python + Playwright (Chromium). Integrating means a second container, a second dependency tree, Chromium on a memory-constrained shared host, and an HTTP seam between the two — for functionality we already have in-process.
3. **It weakens the one thing the pipeline is built around: provenance.** Our design rule is "nothing is asserted without a row to point at": every fact has a source record, every AI claim is quarantined until our own crawler confirms it, every email is checked against numbered facts. An LLM-scraped blob has none of that. We would have to bolt the guards back on around it, at which point it is just a slower `fetchPage()`.
4. **The bottleneck this week was not extraction.** The TracefyHR run returned schools because the plan sliced the ICP's industries to two and scored with the agency catalogue, and because the job aggregators do not cover Gulf SMBs. Those are targeting and source-coverage problems. A smarter scraper reads the wrong pages more cleverly.

## Where it could earn a place later

- **Source coverage for discovery.** The real gap is reach: Bayt, Indeed and Naukri block our fetches; LinkedIn's guest job search and GulfTalent work but need per-title queries. The hosted ScrapeGraph API's anti-bot layer might read the blocked boards. That is a **paid data source** decision, not a library adoption, and it belongs behind a `SourceKind` adapter in `lib/adapters/` that writes `AiCandidate` rows like every other source — so the existence gate still applies.
- **Long-tail extraction on messy company sites** (staff pages in odd layouts, PDF fee tables). If an LLM extractor is ever added for these, do it as an optional `extractorName: "llm"` alongside the deterministic ones, only when a provider is configured, and keep `evidenceSnippet` mandatory. That does not require ScrapeGraphAI; `parseStructured()` already does structured extraction with our prompts.

## Rating

| Criterion | Score (1–5) | Note |
|---|---|---|
| Fit with our architecture | 1 | Python sidecar in a Node stack; no provenance model |
| Solves a current bottleneck | 1 | Bottleneck is targeting and source reach, not extraction |
| Operating cost | 2 | Every page is a paid model call; we have zero credit |
| Maturity / support | 4 | Popular, MIT, active |
| Risk if adopted | 3 | Extra runtime on a shared 2-vCPU box; weaker grounding |

**Overall: 2 / 5 — skip.** Put the effort into (a) restoring an LLM provider so the existing `AI_DISCOVER` and compose stages run at all, (b) more job-board adapters for the Gulf (GulfTalent title pages and LinkedIn guest search are both fetchable today), and (c) the product-aware scoring and plan fixes already in the tree.
