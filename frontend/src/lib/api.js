/**
 * API client.
 *
 * The backend always answers `{ success, message?, data? }`, so unwrapping and
 * error handling live here once rather than in every component.
 */
export class ApiError extends Error {
  constructor(message, { status, code, field, details } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
    this.details = details;
  }
}

/**
 * Notified whenever the API answers 401, so the app can drop to the login
 * screen from anywhere without every caller having to check for it. Registered
 * by AuthProvider; a no-op until then.
 */
let onUnauthorized = null;
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

const request = async (path, { method = "GET", body, signal } = {}) => {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      signal,
      // The session lives in an httpOnly cookie, so every call has to carry it.
      credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new ApiError("Could not reach the server. Is the API running?", { status: 0 });
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    throw new ApiError(`Unexpected response from the server (HTTP ${res.status}).`, { status: res.status });
  }

  if (!res.ok || payload.success === false) {
    // The session ended (expired, revoked, or the server restarted with a
    // cleared table). Let the app react once, centrally.
    if (res.status === 401 && path !== "/auth/login" && path !== "/auth/me") {
      onUnauthorized?.();
    }
    throw new ApiError(payload.message || `Request failed (HTTP ${res.status}).`, {
      status: res.status,
      code: payload.code,
      field: payload.field,
      details: payload.details,
    });
  }
  return payload.data;
};

const qs = (params = {}) => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
};

export const api = {
  health: () => request("/health"),
  search: (body) => request("/search", { method: "POST", body }),
  parsePreview: (q, signal) => request(`/search/parse${qs({ q })}`, { signal }),
  discoverForQuery: (queryId) => request(`/search/${queryId}/discover`, { method: "POST" }),

  listLeads: (params) => request(`/leads${qs(params)}`),
  // The countries the lead set actually contains — the filter never offers one
  // with nothing behind it.
  listLeadCountries: () => request("/leads/countries"),
  getLead: (id) => request(`/leads/${id}`),
  getProvenance: (id) => request(`/leads/${id}/provenance`),
  updateLeadStatus: (id, body) => request(`/leads/${id}/status`, { method: "PATCH", body }),

  listRuns: () => request("/discovery-runs"),
  getRun: (id) => request(`/discovery-runs/${id}`),
  startRun: (body) => request("/discovery-runs", { method: "POST", body }),
  cancelRun: (id) => request(`/discovery-runs/${id}/cancel`, { method: "POST" }),
  listCategories: () => request("/discovery-runs/categories"),

  // ─── AI deep research ───────────────────────────────────────────────────────
  startResearch: (body) => request("/research", { method: "POST", body }),
  getResearchGrid: (runId) => request(`/research-runs/${runId}/grid`),
  getResearchHistory: (params) => request(`/research-history${qs(params)}`),
  listEmailDrafts: (leadId) => request(`/leads/${leadId}/email-drafts`),
  regenerateEmailDraft: (leadId) => request(`/leads/${leadId}/email-drafts`, { method: "POST" }),

  // ─── SaaS Promoter ─────────────────────────────────────────────────────────
  // A product URL in, an approved ICP out, then discovery runs against it. The
  // run these launch is an ordinary discovery run, so its progress and results
  // are read back through subscribeToRun and getResearchGrid above.
  listPromotedProducts: () => request("/promoter/products"),
  createPromotedProduct: (body) => request("/promoter/products", { method: "POST", body }),
  getPromotedProduct: (id) => request(`/promoter/products/${id}`),
  // Saving the ICP is what approves it — the run endpoint refuses until it has.
  savePromotedProductIcp: (id, body) => request(`/promoter/products/${id}/icp`, { method: "PUT", body }),
  updatePromotedProduct: (id, body) => request(`/promoter/products/${id}`, { method: "PATCH", body }),
  researchPromotedProduct: (id) => request(`/promoter/products/${id}/research`, { method: "POST" }),
  launchPromoterRun: (id, body) => request(`/promoter/products/${id}/runs`, { method: "POST", body }),
  archivePromotedProduct: (id) => request(`/promoter/products/${id}/archive`, { method: "POST" }),

  // ─── Outreach: mailbox, sending, reply tracking, follow-ups ────────────────
  // ─── Bulk campaigns & stats ─────────────────────────────────────────────────
  listLeadIds: (params) => request(`/leads/ids${qs(params)}`),
  leadStatusCounts: (params) => request(`/leads/status-counts${qs(params)}`),
  createCampaign: (body) => request("/outreach/campaigns", { method: "POST", body }),
  // The sender's daily budget before a campaign exists: cap, spent, claimed by
  // other campaigns, warm-up stage, recommended volume.
  campaignPlanner: (params) => request(`/outreach/campaigns/planner${qs(params)}`),
  listCampaigns: () => request("/outreach/campaigns"),

  autopilot: () => request("/outreach/autopilot"),
  updateAutopilot: (body) => request("/outreach/autopilot", { method: "PUT", body }),
  runAutopilot: () => request("/outreach/autopilot/run", { method: "POST" }),
  getCampaign: (id) => request(`/outreach/campaigns/${id}`),
  pauseCampaign: (id) => request(`/outreach/campaigns/${id}/pause`, { method: "POST" }),
  resumeCampaign: (id) => request(`/outreach/campaigns/${id}/resume`, { method: "POST" }),
  // "Start now" on a scheduled campaign is the same transition as resume.
  startCampaign: (id) => request(`/outreach/campaigns/${id}/resume`, { method: "POST" }),
  cancelCampaign: (id) => request(`/outreach/campaigns/${id}/cancel`, { method: "POST" }),
  outreachStats: (params) => request(`/outreach/stats${qs(params)}`),

  listEmailAccounts: () => request("/outreach/accounts"),
  createEmailAccount: (body) => request("/outreach/accounts", { method: "POST", body }),
  updateEmailAccount: (id, body) => request(`/outreach/accounts/${id}`, { method: "PUT", body }),
  setDefaultEmailAccount: (id) => request(`/outreach/accounts/${id}/default`, { method: "POST" }),
  testEmailAccountById: (id) => request(`/outreach/accounts/${id}/test`, { method: "POST" }),
  deleteEmailAccountById: (id) => request(`/outreach/accounts/${id}`, { method: "DELETE" }),
  sendOutreachEmail: (body) => request("/outreach/send", { method: "POST", body }),
  syncOutreach: (accountId) => request("/outreach/sync", { method: "POST", body: accountId ? { accountId } : {} }),
  listThreads: (leadId) => request(`/outreach/threads${qs({ leadId })}`),
  // The working queue: who replied, what chase is due, what is still in flight.
  outreachInbox: (params) => request(`/outreach/inbox${qs(params)}`),
  sendFollowUpNow: (threadId) => request(`/outreach/threads/${threadId}/follow-up`, { method: "POST" }),
  composeBatch: (body) => request("/outreach/compose-batch", { method: "POST", body }),

  // ─── Signatures: reusable sign-offs ────────────────────────────────────────
  // Each row comes back with server-rendered previews (text / html / whatsapp),
  // so nothing here re-implements how a signature looks.
  listSignatures: () => request("/signatures"),
  createSignature: (body) => request("/signatures", { method: "POST", body }),
  updateSignature: (id, body) => request(`/signatures/${id}`, { method: "PUT", body }),
  setDefaultSignature: (id) => request(`/signatures/${id}/default`, { method: "POST" }),
  deleteSignature: (id) => request(`/signatures/${id}`, { method: "DELETE" }),

  // ─── WhatsApp: several QR-paired devices ───────────────────────────────────
  listWhatsAppAccounts: () => request("/outreach/whatsapp/accounts"),
  createWhatsAppAccount: (body) => request("/outreach/whatsapp/accounts", { method: "POST", body }),
  updateWhatsAppAccount: (id, body) => request(`/outreach/whatsapp/accounts/${id}`, { method: "PUT", body }),
  setDefaultWhatsAppAccount: (id) => request(`/outreach/whatsapp/accounts/${id}/default`, { method: "POST" }),
  deleteWhatsAppAccount: (id) => request(`/outreach/whatsapp/accounts/${id}`, { method: "DELETE" }),
  whatsappSession: ({ accountId, forceNew } = {}) =>
    request(`/outreach/whatsapp/session${qs({ accountId, ...(forceNew ? { forceNew: "true" } : {}) })}`),
  whatsappStatus: () => request("/outreach/whatsapp/status"),
  whatsappLogout: (accountId) =>
    request("/outreach/whatsapp/logout", { method: "POST", body: accountId ? { accountId } : {} }),
  sendWhatsApp: (body) => request("/outreach/whatsapp/send", { method: "POST", body }),

  // ─── Authentication ────────────────────────────────────────────────────────
  login: (body) => request("/auth/login", { method: "POST", body }),
  logout: () => request("/auth/logout", { method: "POST" }),
  me: () => request("/auth/me"),
  changePassword: (body) => request("/auth/change-password", { method: "POST", body }),

  // ─── Team & permissions (super admin only) ─────────────────────────────────
  // The catalogue comes from the server rather than being restated here, so the
  // tick boxes in the admin form can never offer a permission the API does not
  // enforce.
  permissionCatalog: () => request("/users/permissions"),
  listUsers: () => request("/users"),
  createUser: (body) => request("/users", { method: "POST", body }),
  updateUser: (id, body) => request(`/users/${id}`, { method: "PATCH", body }),
  setUserPassword: (id, password) => request(`/users/${id}/password`, { method: "POST", body: { password } }),
  unlockUser: (id) => request(`/users/${id}/unlock`, { method: "POST" }),
  revokeUserSessions: (id) => request(`/users/${id}/sessions/revoke`, { method: "POST" }),
  deleteUser: (id) => request(`/users/${id}`, { method: "DELETE" }),

  dashboard: () => request("/stats/dashboard"),
  signalCatalog: () => request("/signals/catalog"),

  // ─── Client book ───────────────────────────────────────────────────────────
  listClients: (params) => request(`/clients${qs(params)}`),
  // The counts and filter options the toolbar is allowed to offer — always
  // derived from the clients that exist, never from a static list.
  clientFacets: () => request("/clients/facets"),
  getClient: (id) => request(`/clients/${id}`),
  createClient: (body) => request("/clients", { method: "POST", body }),
  updateClient: (id, body) => request(`/clients/${id}`, { method: "PUT", body }),
  deleteClient: (id) => request(`/clients/${id}`, { method: "DELETE" }),

  createClientProject: (clientId, body) => request(`/clients/${clientId}/projects`, { method: "POST", body }),
  updateClientProject: (clientId, projectId, body) => request(`/clients/${clientId}/projects/${projectId}`, { method: "PUT", body }),
  deleteClientProject: (clientId, projectId) => request(`/clients/${clientId}/projects/${projectId}`, { method: "DELETE" }),

  logClientTouchpoint: (clientId, body) => request(`/clients/${clientId}/touchpoints`, { method: "POST", body }),

  listSuppression: () => request("/suppression"),
  addSuppression: (body) => request("/suppression", { method: "POST", body }),
  removeSuppression: (id) => request(`/suppression/${id}`, { method: "DELETE" }),

  /**
   * Download a full database backup.
   *
   * Does not go through request(): the success path is a gzip stream, not JSON,
   * and the failure path still is. Returns { blob, filename } for the caller to
   * save.
   *
   * A dump that dies partway is aborted by the server mid-transfer rather than
   * ended cleanly, so it arrives here as a network error. That is deliberate —
   * it is the difference between a failed download and a truncated backup you
   * would not discover until you tried to restore it — so it is reported as
   * such rather than being smoothed over.
   */
  downloadBackup: async (password) => {
    let res;
    try {
      res = await fetch("/api/backup/database", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
    } catch {
      throw new ApiError(
        "The backup stopped partway and the file is incomplete. Do not keep it — try again.",
        { status: 0 },
      );
    }

    if (!res.ok) {
      let message = `The backup failed (HTTP ${res.status}).`;
      try {
        const payload = await res.json();
        if (payload?.message) message = payload.message;
      } catch { /* non-JSON error body — keep the default */ }
      if (res.status === 401) onUnauthorized?.();
      throw new ApiError(message, { status: res.status });
    }

    let blob;
    try {
      blob = await res.blob();
    } catch {
      throw new ApiError(
        "The backup stopped partway and the file is incomplete. Do not keep it — try again.",
        { status: 0 },
      );
    }

    const disposition = res.headers.get("content-disposition") || "";
    const match = /filename="?([^"]+)"?/.exec(disposition);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
    return { blob, filename: match?.[1] || `leadsignal-backup-${stamp}.sql.gz` };
  },
};

/**
 * Subscribe to a discovery run's progress stream.
 * @returns {() => void} unsubscribe
 */
export const subscribeToRun = (runId, onEvent, onError) => {
  const source = new EventSource(`/api/discovery-runs/${runId}/events`);
  source.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      /* keep-alive comments and malformed frames are not worth surfacing */
    }
  };
  source.onerror = () => {
    // EventSource retries on its own; only report once the run is unreachable.
    if (source.readyState === EventSource.CLOSED) onError?.(new Error("Progress stream closed."));
  };
  return () => source.close();
};
