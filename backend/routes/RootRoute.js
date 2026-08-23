import { Router } from "express";
import { z } from "zod";
import { validate } from "../middlewares/validate.js";
import { searchLimiter, discoveryLimiter, writeLimiter } from "../middlewares/rateLimiter.js";
import * as search from "../controllers/subControllers/searchController.js";
import * as leads from "../controllers/subControllers/leadController.js";
import * as discovery from "../controllers/subControllers/discoveryController.js";
import * as stats from "../controllers/subControllers/statsController.js";
import * as research from "../controllers/subControllers/researchController.js";
import * as outreach from "../controllers/subControllers/outreachController.js";
import * as signatures from "../controllers/subControllers/signatureController.js";

const router = Router();
const idParam = z.object({ id: z.string().min(1).max(64) });

// ─── Search & discovery ───────────────────────────────────────────────────────
router.post("/search", searchLimiter, validate({ body: search.searchSchema }), search.search);
router.get("/search/parse", search.previewParse);
router.post("/search/:queryId/discover", discoveryLimiter, search.discoverForQuery);

router.get("/discovery-runs", discovery.listRuns);
router.get("/discovery-runs/categories", discovery.listCategories);
router.post("/discovery-runs", discoveryLimiter, validate({ body: discovery.manualRunSchema }), discovery.startManualRun);
router.get("/discovery-runs/:id", validate({ params: idParam }), discovery.getRun);
router.get("/discovery-runs/:id/events", validate({ params: idParam }), discovery.streamRun);
router.post("/discovery-runs/:id/cancel", validate({ params: idParam }), discovery.cancelRun);

// ─── AI deep research ─────────────────────────────────────────────────────────
router.post("/research", discoveryLimiter, validate({ body: research.researchSchema }), research.startResearch);
router.get("/research-history", validate({ query: research.historySchema }), research.getHistory);
router.get("/research-runs/:id/grid", validate({ params: idParam }), research.getResearchGrid);

// ─── Leads ────────────────────────────────────────────────────────────────────
router.get("/leads", validate({ query: leads.listSchema }), leads.listLeads);
// Must be registered before /leads/:id — otherwise "countries" is read as an id.
router.get("/leads/countries", leads.listCountries);
router.get("/leads/:id", validate({ params: idParam }), leads.getLead);
router.get("/leads/:id/provenance", validate({ params: idParam }), leads.getProvenance);
router.get("/leads/:id/email-drafts", validate({ params: idParam }), research.listEmailDrafts);
router.post("/leads/:id/email-drafts", writeLimiter, validate({ params: idParam }), research.regenerateEmailDraft);
router.patch("/leads/:id/status", writeLimiter, validate({ params: idParam, body: leads.statusSchema }), leads.updateStatus);

// ─── Outreach: mailboxes, sending, reply tracking, follow-ups ─────────────────
// Several mailboxes may be connected at once; the composer picks which one
// sends. /outreach/account (singular) acts on the default sender.
router.get("/outreach/accounts", outreach.listAccountInfo);
router.post("/outreach/accounts", writeLimiter, validate({ body: outreach.accountSchema }), outreach.createAccount);
router.put("/outreach/accounts/:id", writeLimiter, validate({ params: idParam, body: outreach.accountSchema }), outreach.updateAccount);
router.post("/outreach/accounts/:id/default", writeLimiter, validate({ params: idParam }), outreach.setDefaultAccount);
router.post("/outreach/accounts/:id/test", writeLimiter, validate({ params: idParam }), outreach.testAccountById);
router.delete("/outreach/accounts/:id", writeLimiter, validate({ params: idParam }), outreach.deleteAccountById);

router.get("/outreach/account", outreach.getAccountInfo);
router.put("/outreach/account", writeLimiter, validate({ body: outreach.accountSchema }), outreach.saveAccount);
router.post("/outreach/account/test", writeLimiter, outreach.testAccount);
router.delete("/outreach/account", writeLimiter, outreach.deleteAccount);
router.post("/outreach/send", writeLimiter, validate({ body: outreach.sendSchema }), outreach.send);
router.post("/outreach/sync", writeLimiter, validate({ body: outreach.syncQuerySchema }), outreach.syncNow);
router.get("/outreach/threads", validate({ query: outreach.threadsQuerySchema }), outreach.listThreads);
router.post("/outreach/threads/:id/follow-up", writeLimiter, validate({ params: idParam }), outreach.followUpNow);
router.post("/outreach/compose-batch", writeLimiter, validate({ body: outreach.composeBatchSchema }), outreach.composeBatch);

// ─── Signatures: reusable sign-offs, one selected per send ───────────────────
router.get("/signatures", signatures.list);
router.post("/signatures", writeLimiter, validate({ body: signatures.signatureSchema }), signatures.create);
router.put("/signatures/:id", writeLimiter, validate({ params: idParam, body: signatures.signatureSchema }), signatures.update);
router.post("/signatures/:id/default", writeLimiter, validate({ params: idParam }), signatures.setDefault);
router.delete("/signatures/:id", writeLimiter, validate({ params: idParam }), signatures.remove);

// ─── WhatsApp (several QR-paired devices) ────────────────────────────────────
// The plural /accounts routes manage devices; the singular /session, /status
// and /logout act on the default device and predate multi-device support.
router.get("/outreach/whatsapp/accounts", outreach.listWhatsAppAccountInfo);
router.post("/outreach/whatsapp/accounts", writeLimiter, validate({ body: outreach.whatsappAccountSchema }), outreach.createWhatsAppAccountHandler);
router.post("/outreach/whatsapp/accounts/:id/default", writeLimiter, validate({ params: idParam }), outreach.setDefaultWhatsAppAccount);
router.delete("/outreach/whatsapp/accounts/:id", writeLimiter, validate({ params: idParam }), outreach.deleteWhatsAppAccountHandler);

router.get("/outreach/whatsapp/session", validate({ query: outreach.whatsappSessionQuerySchema }), outreach.whatsappSession);
router.get("/outreach/whatsapp/status", outreach.whatsappStatusInfo);
router.post("/outreach/whatsapp/logout", writeLimiter, validate({ body: outreach.whatsappLogoutSchema }), outreach.whatsappLogoutHandler);
router.post("/outreach/whatsapp/send", writeLimiter, validate({ body: outreach.whatsappSendSchema }), outreach.whatsappSend);

// ─── Reference data & operations ──────────────────────────────────────────────
router.get("/signals/catalog", stats.signalCatalog);
router.get("/stats/dashboard", stats.dashboard);
router.get("/suppression", stats.listSuppression);
router.post("/suppression", writeLimiter, validate({ body: stats.suppressionSchema }), stats.addSuppression);
router.delete("/suppression/:id", writeLimiter, validate({ params: idParam }), stats.removeSuppression);
router.get("/health", stats.health);

export default router;
