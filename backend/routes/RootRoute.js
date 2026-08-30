import { Router } from "express";
import { z } from "zod";
import { validate } from "../middlewares/validate.js";
import { searchLimiter, discoveryLimiter, writeLimiter } from "../middlewares/rateLimiter.js";
import * as search from "../controllers/subControllers/searchController.js";
import * as leads from "../controllers/subControllers/leadController.js";
import * as discovery from "../controllers/subControllers/discoveryController.js";
import * as stats from "../controllers/subControllers/statsController.js";
import * as research from "../controllers/subControllers/researchController.js";
import * as promoter from "../controllers/subControllers/promoterController.js";
import * as outreach from "../controllers/subControllers/outreachController.js";
import * as campaigns from "../controllers/subControllers/campaignController.js";
import * as signatures from "../controllers/subControllers/signatureController.js";
import * as clients from "../controllers/subControllers/clientController.js";
import * as auth from "../controllers/subControllers/authController.js";
import * as backup from "../controllers/subControllers/backupController.js";
import * as users from "../controllers/subControllers/userController.js";
import {
  requireAuth, requireRole, requirePermission, requireUserAdmin, blockReadOnlyWrites,
} from "../middlewares/requireAuth.js";
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

// A read-only seat is refused every state-changing request, once, for the whole
// authenticated surface. Per-route would be worse: a VIEWER who could write
// through the one endpoint somebody forgot to annotate is not read-only at all.
// Changing your own password is the single exception, and is registered above.
router.use(blockReadOnlyWrites);

// ─── Section gates ────────────────────────────────────────────────────────────
// One permission key per sidebar destination (lib/auth/permissions.js), applied
// here so the map from "what the sidebar shows" to "what the API answers" is
// readable in one place.
//
// Several gates accept more than one key. That is not laxity: an endpoint can
// legitimately serve several screens — the lead list feeds All leads, SaaS
// Promoter and the bulk-send picker alike, and a promoter who could not read it
// would be looking at an empty product. The rule is that a gate names every
// screen that genuinely needs the data, and nothing beyond it.
const canSearch        = requirePermission("search");
const canDiscover      = requirePermission("discovery");
const canWatchRun      = requirePermission("discovery", "search", "research", "promoter");
const canResearch      = requirePermission("research");
const canPromote       = requirePermission("promoter");
const canListLeads     = requirePermission("leads", "promoter", "outreach", "research", "inbox");
const canOpenLead      = requirePermission("leads", "promoter", "outreach", "research");
const canSetLeadStatus = requirePermission("leads", "inbox");
const canOutreach      = requirePermission("outreach");
const canInbox         = requirePermission("inbox");
const canReadThreads   = requirePermission("inbox", "leads", "outreach", "research", "promoter");
const canFollowUp      = requirePermission("inbox", "outreach");
const canSyncMailboxes = requirePermission("inbox", "outreach", "settings");
// Reading *which* mailbox, device or sign-off to send from is part of sending,
// so the composer works for someone who has Outreach but not Settings. Creating
// and editing them stays behind Settings.
const canReadSenders   = requirePermission("outreach", "settings");
const canSettings      = requirePermission("settings");
const canClients       = requirePermission("clients");
const canDashboard     = requirePermission("dashboard");

// ─── Search & discovery ───────────────────────────────────────────────────────
router.post("/search", canSearch, searchLimiter, validate({ body: search.searchSchema }), search.search);
router.get("/search/parse", canSearch, search.previewParse);
router.post("/search/:queryId/discover", canSearch, discoveryLimiter, search.discoverForQuery);

router.get("/discovery-runs", canDiscover, discovery.listRuns);
router.get("/discovery-runs/categories", canDiscover, discovery.listCategories);
router.post("/discovery-runs", canDiscover, discoveryLimiter, validate({ body: discovery.manualRunSchema }), discovery.startManualRun);
// The progress panel is rendered by four screens, so watching and cancelling a
// run is open to any of them — it reveals nothing the launching screen did not.
router.get("/discovery-runs/:id", canWatchRun, validate({ params: idParam }), discovery.getRun);
router.get("/discovery-runs/:id/events", canWatchRun, validate({ params: idParam }), discovery.streamRun);
router.post("/discovery-runs/:id/cancel", canWatchRun, validate({ params: idParam }), discovery.cancelRun);

// ─── AI deep research ─────────────────────────────────────────────────────────
router.post("/research", canResearch, discoveryLimiter, validate({ body: research.researchSchema }), research.startResearch);
router.get("/research-history", canResearch, validate({ query: research.historySchema }), research.getHistory);
router.get("/research-runs/:id/grid", canResearch, validate({ params: idParam }), research.getResearchGrid);

// ─── SaaS promoter: sell someone else's product instead of our own ───────────
// A product URL is researched into a profile and a drafted ICP, and the ICP is
// then edited and saved by a person. That save is the gate: POST /runs answers
// 403 until it has happened, so no one is ever contacted on the strength of a
// profile nobody read. The runs it launches are ordinary discovery runs, read
// back through /discovery-runs and /research-runs above.
router.get("/promoter/products", canPromote, promoter.listProducts);
router.post("/promoter/products", canPromote, discoveryLimiter, validate({ body: promoter.productCreateSchema }), promoter.createProduct);
router.get("/promoter/products/:id", canPromote, validate({ params: idParam }), promoter.getProduct);
router.patch("/promoter/products/:id", canPromote, writeLimiter, validate({ params: idParam, body: promoter.productPatchSchema }), promoter.patchProduct);
router.put("/promoter/products/:id/icp", canPromote, writeLimiter, validate({ params: idParam, body: promoter.icpApproveSchema }), promoter.approveProductIcp);
router.post("/promoter/products/:id/research", canPromote, discoveryLimiter, validate({ params: idParam }), promoter.researchProduct);
router.post("/promoter/products/:id/runs", canPromote, discoveryLimiter, validate({ params: idParam, body: promoter.runLaunchSchema }), promoter.launchRun);
router.post("/promoter/products/:id/archive", canPromote, writeLimiter, validate({ params: idParam }), promoter.archiveProduct);

// ─── Leads ────────────────────────────────────────────────────────────────────
router.get("/leads", canListLeads, validate({ query: leads.listSchema }), leads.listLeads);
// Must be registered before /leads/:id — otherwise "countries" is read as an id.
router.get("/leads/countries", canListLeads, leads.listCountries);
router.get("/leads/ids", canListLeads, validate({ query: leads.listSchema }), leads.listLeadIds);
router.get("/leads/status-counts", canListLeads, validate({ query: leads.listSchema }), leads.statusCounts);
router.get("/leads/:id", canOpenLead, validate({ params: idParam }), leads.getLead);
router.get("/leads/:id/provenance", canOpenLead, validate({ params: idParam }), leads.getProvenance);
router.get("/leads/:id/email-drafts", canOpenLead, validate({ params: idParam }), research.listEmailDrafts);
router.post("/leads/:id/email-drafts", canOpenLead, writeLimiter, validate({ params: idParam }), research.regenerateEmailDraft);
// Also reachable from the Inbox, where judging a reply *is* a status change.
router.patch("/leads/:id/status", canSetLeadStatus, writeLimiter, validate({ params: idParam, body: leads.statusSchema }), leads.updateStatus);

// ─── Outreach: mailboxes, sending, reply tracking, follow-ups ─────────────────
// Several mailboxes may be connected at once; the composer picks which one
// sends. /outreach/account (singular) acts on the default sender.
router.get("/outreach/accounts", canReadSenders, outreach.listAccountInfo);
router.post("/outreach/accounts", canSettings, writeLimiter, validate({ body: outreach.accountSchema }), outreach.createAccount);
router.put("/outreach/accounts/:id", canSettings, writeLimiter, validate({ params: idParam, body: outreach.accountSchema }), outreach.updateAccount);
router.post("/outreach/accounts/:id/default", canSettings, writeLimiter, validate({ params: idParam }), outreach.setDefaultAccount);
router.post("/outreach/accounts/:id/test", canSettings, writeLimiter, validate({ params: idParam }), outreach.testAccountById);
router.delete("/outreach/accounts/:id", canSettings, writeLimiter, validate({ params: idParam }), outreach.deleteAccountById);

router.get("/outreach/account", canReadSenders, outreach.getAccountInfo);
router.put("/outreach/account", canSettings, writeLimiter, validate({ body: outreach.accountSchema }), outreach.saveAccount);
router.post("/outreach/account/test", canSettings, writeLimiter, outreach.testAccount);
router.delete("/outreach/account", canSettings, writeLimiter, outreach.deleteAccount);
// ─── Bulk campaigns & outreach stats ─────────────────────────────────────────
router.post("/outreach/campaigns", canOutreach, writeLimiter, validate({ body: campaigns.campaignCreateSchema }), campaigns.create);
router.get("/outreach/campaigns", canOutreach, campaigns.list);
// Before `/:id`, or "planner" would be looked up as a campaign id.
router.get("/outreach/campaigns/planner", canOutreach, validate({ query: campaigns.plannerSchema }), campaigns.planner);
router.get("/outreach/campaigns/:id", canOutreach, validate({ params: idParam }), campaigns.detail);
router.post("/outreach/campaigns/:id/pause", canOutreach, writeLimiter, validate({ params: idParam }), campaigns.pause);
router.post("/outreach/campaigns/:id/resume", canOutreach, writeLimiter, validate({ params: idParam }), campaigns.resume);
router.post("/outreach/campaigns/:id/cancel", canOutreach, writeLimiter, validate({ params: idParam }), campaigns.cancel);
router.get("/outreach/stats", requirePermission("outreach", "dashboard"), validate({ query: campaigns.statsSchema }), campaigns.stats);
router.post("/outreach/drafts/regenerate", canOutreach, writeLimiter, campaigns.regenerate);
router.get("/outreach/drafts/context", canOutreach, campaigns.draftContext);
router.post("/outreach/drafts/import", canOutreach, writeLimiter, validate({ body: campaigns.draftImportSchema }), campaigns.draftImport);
router.post("/outreach/contacts/hygiene", canOutreach, writeLimiter, campaigns.hygiene);

router.post("/outreach/send", canOutreach, writeLimiter, validate({ body: outreach.sendSchema }), outreach.send);
router.post("/outreach/sync", canSyncMailboxes, writeLimiter, validate({ body: outreach.syncQuerySchema }), outreach.syncNow);
router.get("/outreach/inbox", canInbox, validate({ query: outreach.inboxQuerySchema }), outreach.inbox);
router.get("/outreach/threads", canReadThreads, validate({ query: outreach.threadsQuerySchema }), outreach.listThreads);
router.post("/outreach/threads/:id/follow-up", canFollowUp, writeLimiter, validate({ params: idParam }), outreach.followUpNow);
router.post("/outreach/compose-batch", requirePermission("research", "outreach"), writeLimiter, validate({ body: outreach.composeBatchSchema }), outreach.composeBatch);

// ─── Signatures: reusable sign-offs, one selected per send ───────────────────
router.get("/signatures", canReadSenders, signatures.list);
router.post("/signatures", canSettings, writeLimiter, validate({ body: signatures.signatureSchema }), signatures.create);
router.put("/signatures/:id", canSettings, writeLimiter, validate({ params: idParam, body: signatures.signatureSchema }), signatures.update);
router.post("/signatures/:id/default", canSettings, writeLimiter, validate({ params: idParam }), signatures.setDefault);
router.delete("/signatures/:id", canSettings, writeLimiter, validate({ params: idParam }), signatures.remove);

// ─── WhatsApp (several QR-paired devices) ────────────────────────────────────
// The plural /accounts routes manage devices; the singular /session, /status
// and /logout act on the default device and predate multi-device support.
router.get("/outreach/whatsapp/accounts", canReadSenders, outreach.listWhatsAppAccountInfo);
router.post("/outreach/whatsapp/accounts", canSettings, writeLimiter, validate({ body: outreach.whatsappAccountSchema }), outreach.createWhatsAppAccountHandler);
router.put("/outreach/whatsapp/accounts/:id", canSettings, writeLimiter, validate({ params: idParam, body: outreach.whatsappAccountUpdateSchema }), outreach.updateWhatsAppAccountHandler);
router.post("/outreach/whatsapp/accounts/:id/default", canSettings, writeLimiter, validate({ params: idParam }), outreach.setDefaultWhatsAppAccount);
router.delete("/outreach/whatsapp/accounts/:id", canSettings, writeLimiter, validate({ params: idParam }), outreach.deleteWhatsAppAccountHandler);

// Pairing a phone is a Settings act; knowing whether one is connected is what
// the composer needs before it offers WhatsApp as a channel.
router.get("/outreach/whatsapp/session", canSettings, validate({ query: outreach.whatsappSessionQuerySchema }), outreach.whatsappSession);
router.get("/outreach/whatsapp/status", canReadSenders, outreach.whatsappStatusInfo);
router.post("/outreach/whatsapp/logout", canSettings, writeLimiter, validate({ body: outreach.whatsappLogoutSchema }), outreach.whatsappLogoutHandler);
router.post("/outreach/whatsapp/send", canOutreach, writeLimiter, validate({ body: outreach.whatsappSendSchema }), outreach.whatsappSend);

// ─── Client book: companies we have already worked for ───────────────────────
// Separate from /leads on purpose: a lead is evidence the discovery engine owns
// and rewrites, a client is a record a person typed and owns outright.
// /clients/facets must precede /clients/:id, or "facets" is read as an id.
router.get("/clients", canClients, validate({ query: clients.listSchema }), clients.listClients);
router.get("/clients/facets", canClients, clients.clientFacets);
router.post("/clients", canClients, writeLimiter, validate({ body: clients.createSchema }), clients.createClient);
router.get("/clients/:id", canClients, validate({ params: idParam }), clients.getClient);
router.put("/clients/:id", canClients, writeLimiter, validate({ params: idParam, body: clients.updateSchema }), clients.updateClient);
router.delete("/clients/:id", canClients, writeLimiter, validate({ params: idParam }), clients.deleteClient);

router.post("/clients/:id/projects", canClients, writeLimiter, validate({ params: idParam, body: clients.projectSchema }), clients.createProject);
router.put("/clients/:id/projects/:projectId", canClients, writeLimiter, validate({ params: nestedIdParam, body: clients.projectSchema }), clients.updateProject);
router.delete("/clients/:id/projects/:projectId", canClients, writeLimiter, validate({ params: nestedIdParam }), clients.deleteProject);

router.post("/clients/:id/touchpoints", canClients, writeLimiter, validate({ params: idParam, body: clients.touchpointSchema }), clients.logTouchpoint);

// ─── Reference data & operations ──────────────────────────────────────────────
// Ungated on purpose: the catalogue is the static scoring reference — what each
// signal is worth and how fast it decays — and carries no company or lead data.
router.get("/signals/catalog", stats.signalCatalog);
router.get("/stats/dashboard", canDashboard, stats.dashboard);
router.get("/suppression", canSettings, stats.listSuppression);
router.post("/suppression", canSettings, writeLimiter, validate({ body: stats.suppressionSchema }), stats.addSuppression);
router.delete("/suppression/:id", canSettings, writeLimiter, validate({ params: idParam }), stats.removeSuppression);

// ─── Team & permissions ───────────────────────────────────────────────────────
// Super admin only, and deliberately not a grantable permission: a member who
// could tick "Team" could tick every other box a second later, which would make
// the whole model decorative. See lib/auth/permissions.js.
router.get("/users/permissions", requireUserAdmin, users.catalog);
router.get("/users", requireUserAdmin, users.list);
router.post("/users", requireUserAdmin, writeLimiter, validate({ body: users.createUserSchema }), users.create);
router.patch("/users/:id", requireUserAdmin, writeLimiter, validate({ params: idParam, body: users.updateUserSchema }), users.update);
router.post("/users/:id/password", requireUserAdmin, writeLimiter, validate({ params: idParam, body: users.setPasswordSchema }), users.setPassword);
router.post("/users/:id/unlock", requireUserAdmin, writeLimiter, validate({ params: idParam }), users.unlock);
router.post("/users/:id/sessions/revoke", requireUserAdmin, writeLimiter, validate({ params: idParam }), users.revokeSessions);
router.delete("/users/:id", requireUserAdmin, writeLimiter, validate({ params: idParam }), users.remove);

// ─── Database backup ──────────────────────────────────────────────────────────
// POST, not GET: the body carries the backup password, and a secret in a query
// string is written to nginx's access log and kept in browser history. ADMIN
// only — a VIEWER can read leads in the UI but must not be able to walk out
// with the whole database in one file.
router.post("/backup/database", requireRole("ADMIN"), writeLimiter,
  validate({ body: backup.backupSchema }), backup.downloadDatabaseBackup);
export default router;
