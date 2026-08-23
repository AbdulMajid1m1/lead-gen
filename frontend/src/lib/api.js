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

const request = async (path, { method = "GET", body, signal } = {}) => {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      signal,
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

  // ─── Outreach: mailbox, sending, reply tracking, follow-ups ────────────────
  listEmailAccounts: () => request("/outreach/accounts"),
  createEmailAccount: (body) => request("/outreach/accounts", { method: "POST", body }),
  updateEmailAccount: (id, body) => request(`/outreach/accounts/${id}`, { method: "PUT", body }),
  setDefaultEmailAccount: (id) => request(`/outreach/accounts/${id}/default`, { method: "POST" }),
  testEmailAccountById: (id) => request(`/outreach/accounts/${id}/test`, { method: "POST" }),
  deleteEmailAccountById: (id) => request(`/outreach/accounts/${id}`, { method: "DELETE" }),
  sendOutreachEmail: (body) => request("/outreach/send", { method: "POST", body }),
  syncOutreach: (accountId) => request("/outreach/sync", { method: "POST", body: accountId ? { accountId } : {} }),
  listThreads: (leadId) => request(`/outreach/threads${qs({ leadId })}`),
  sendFollowUpNow: (threadId) => request(`/outreach/threads/${threadId}/follow-up`, { method: "POST" }),
  composeBatch: (body) => request("/outreach/compose-batch", { method: "POST", body }),

  // WhatsApp (one QR-paired device)
  whatsappSession: (forceNew) => request(`/outreach/whatsapp/session${qs(forceNew ? { forceNew: "true" } : {})}`),
  whatsappStatus: () => request("/outreach/whatsapp/status"),
  whatsappLogout: () => request("/outreach/whatsapp/logout", { method: "POST" }),
  sendWhatsApp: (body) => request("/outreach/whatsapp/send", { method: "POST", body }),

  dashboard: () => request("/stats/dashboard"),
  signalCatalog: () => request("/signals/catalog"),

  listSuppression: () => request("/suppression"),
  addSuppression: (body) => request("/suppression", { method: "POST", body }),
  removeSuppression: (id) => request(`/suppression/${id}`, { method: "DELETE" }),
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
