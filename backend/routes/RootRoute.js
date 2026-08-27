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
import * as campaigns from "../controllers/subControllers/campaignController.js";
import * as signatures from "../controllers/subControllers/signatureController.js";
import * as clients from "../controllers/subControllers/clientController.js";
import * as auth from "../controllers/subControllers/authController.js";
import * as backup from "../controllers/subControllers/backupController.js";
import { requireAuth, requireRole } from "../middlewares/requireAuth.js";
import { loginLimiter } from "../middlewares/rateLimiter.js";

const router = Router();
const idParam = z.object({ id: z.string().min(1).max(64) });
const nestedIdParam = z.object({ id: z.string().min(1).max(64), projectId: z.string().min(1).max(64) });

// ─── Authentication ───────────────────────────────────────────────────────────
// Mounted before the gate below, because these are the only routes a
// signed-out browser is allowed to reach.
router.post("/auth/login", loginLimiter, validate({ body: auth.loginSchema }), auth.login);
router.post("/auth/logout", auth.logout);
router.get("/auth/me", requireAuth, auth.me);
router.post("/auth/change-password", requireAuth, writeLimiter, validate({ body: auth.changePasswordSchema }), auth.changePassword);

// Liveness has to answer for the container healthcheck and for nginx, neither
// of which carries a cookie — so it sits outside the gate too. It reports only
// "can I reach Postgres", never any lead data.
router.get("/health", stats.health);

// ─── Everything below this line requires a session ────────────────────────────
// A single gate rather than a per-route flag: adding a route to this file must
// not be a way to accidentally publish one. Anything genuinely public has to be
// registered above, where that intent is visible.
router.use(requireAuth);

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
router.get("/leads/ids", validate({ query: leads.listSchema }), leads.listLeadIds);
router.get("/leads/status-counts", validate({ query: leads.listSchema }), leads.statusCounts);
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
// ─── Bulk campaigns & outreach stats ─────────────────────────────────────────
router.post("/outreach/campaigns", writeLimiter, validate({ body: campaigns.campaignCreateSchema }), campaigns.create);
router.get("/outreach/campaigns", campaigns.list);
router.get("/outreach/campaigns/:id", validate({ params: idParam }), campaigns.detail);
router.post("/outreach/campaigns/:id/pause", writeLimiter, validate({ params: idParam }), campaigns.pause);
router.post("/outreach/campaigns/:id/resume", writeLimiter, validate({ params: idParam }), campaigns.resume);
router.post("/outreach/campaigns/:id/cancel", writeLimiter, validate({ params: idParam }), campaigns.cancel);
router.get("/outreach/stats", validate({ query: campaigns.statsSchema }), campaigns.stats);
router.post("/outreach/drafts/regenerate", writeLimiter, campaigns.regenerate);
router.get("/outreach/drafts/context", campaigns.draftContext);
router.post("/outreach/drafts/import", writeLimiter, validate({ body: campaigns.draftImportSchema }), campaigns.draftImport);
router.post("/outreach/contacts/hygiene", writeLimiter, campaigns.hygiene);

router.post("/outreach/send", writeLimiter, validate({ body: outreach.sendSchema }), outreach.send);
router.post("/outreach/sync", writeLimiter, validate({ body: outreach.syncQuerySchema }), outreach.syncNow);
router.get("/outreach/inbox", validate({ query: outreach.inboxQuerySchema }), outreach.inbox);
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
router.put("/outreach/whatsapp/accounts/:id", writeLimiter, validate({ params: idParam, body: outreach.whatsappAccountUpdateSchema }), outreach.updateWhatsAppAccountHandler);
router.post("/outreach/whatsapp/accounts/:id/default", writeLimiter, validate({ params: idParam }), outreach.setDefaultWhatsAppAccount);
router.delete("/outreach/whatsapp/accounts/:id", writeLimiter, validate({ params: idParam }), outreach.deleteWhatsAppAccountHandler);

router.get("/outreach/whatsapp/session", validate({ query: outreach.whatsappSessionQuerySchema }), outreach.whatsappSession);
router.get("/outreach/whatsapp/status", outreach.whatsappStatusInfo);
router.post("/outreach/whatsapp/logout", writeLimiter, validate({ body: outreach.whatsappLogoutSchema }), outreach.whatsappLogoutHandler);
router.post("/outreach/whatsapp/send", writeLimiter, validate({ body: outreach.whatsappSendSchema }), outreach.whatsappSend);

// ─── Client book: companies we have already worked for ───────────────────────
// Separate from /leads on purpose: a lead is evidence the discovery engine owns
// and rewrites, a client is a record a person typed and owns outright.
// /clients/facets must precede /clients/:id, or "facets" is read as an id.
router.get("/clients", validate({ query: clients.listSchema }), clients.listClients);
router.get("/clients/facets", clients.clientFacets);
router.post("/clients", writeLimiter, validate({ body: clients.createSchema }), clients.createClient);
router.get("/clients/:id", validate({ params: idParam }), clients.getClient);
router.put("/clients/:id", writeLimiter, validate({ params: idParam, body: clients.updateSchema }), clients.updateClient);
router.delete("/clients/:id", writeLimiter, validate({ params: idParam }), clients.deleteClient);

router.post("/clients/:id/projects", writeLimiter, validate({ params: idParam, body: clients.projectSchema }), clients.createProject);
router.put("/clients/:id/projects/:projectId", writeLimiter, validate({ params: nestedIdParam, body: clients.projectSchema }), clients.updateProject);
router.delete("/clients/:id/projects/:projectId", writeLimiter, validate({ params: nestedIdParam }), clients.deleteProject);

router.post("/clients/:id/touchpoints", writeLimiter, validate({ params: idParam, body: clients.touchpointSchema }), clients.logTouchpoint);

// ─── Reference data & operations ──────────────────────────────────────────────
router.get("/signals/catalog", stats.signalCatalog);
router.get("/stats/dashboard", stats.dashboard);
router.get("/suppression", stats.listSuppression);
router.post("/suppression", writeLimiter, validate({ body: stats.suppressionSchema }), stats.addSuppression);
router.delete("/suppression/:id", writeLimiter, validate({ params: idParam }), stats.removeSuppression);

// ─── Database backup ──────────────────────────────────────────────────────────
// POST, not GET: the body carries the backup password, and a secret in a query
// string is written to nginx's access log and kept in browser history. ADMIN
// only — a VIEWER can read leads in the UI but must not be able to walk out
// with the whole database in one file.
router.post("/backup/database", requireRole("ADMIN"), writeLimiter,
  validate({ body: backup.backupSchema }), backup.downloadDatabaseBackup);
export default router;
