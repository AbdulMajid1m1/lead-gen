import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";
import prisma from "../../prismaClient.js";
import { log } from "../../utils/logger.js";

const logger = log("outreach:whatsapp");

/**
 * WhatsApp sending over Baileys — a pure WebSocket client, no browser needed.
 *
 * Several devices can be linked at once. Each WhatsAppAccount row owns a socket
 * and a credential folder (.baileys_auth/<accountId>), held together in the
 * `sessions` map below. This used to be a single module-level socket; the map
 * is the whole difference, and it is why every function here takes an accountId.
 *
 * Two things follow from multi-device that are easy to get wrong:
 *
 *  · An incoming message must be matched only against threads belonging to the
 *    device that received it. Matching globally would attribute a reply to
 *    whichever thread happened to share the last nine digits, on any phone.
 *  · A device's DB row is the source of truth for "is this paired", not the
 *    in-memory socket — the process restarts, the pairing does not.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTH_ROOT = process.env.WHATSAPP_AUTH_DIR || path.join(here, "../../.baileys_auth");
const MAX_RECONNECT_ATTEMPTS = 3;
const QR_WAIT_MS = 60_000;

const baileysLogger = pino({ level: "silent" });

/** accountId → live socket state. Absent means "not connected right now". */
const sessions = new Map();

const blankState = () => ({
  sock: null,
  connected: false,
  qr: null,
  user: null,
  initializing: false,
  intentionalLogout: false,
  reconnectAttempts: 0,
});

const stateFor = (accountId) => {
  if (!sessions.has(accountId)) sessions.set(accountId, blankState());
  return sessions.get(accountId);
};

const authDir = (accountId) => path.join(AUTH_ROOT, accountId);
const hasCreds = (accountId) => fs.existsSync(path.join(authDir(accountId), "creds.json"));

const wipeCreds = (accountId) => {
  try {
    fs.rmSync(authDir(accountId), { recursive: true, force: true });
  } catch (err) {
    logger.warn({ accountId, msg: err.message }, "could not clean auth folder");
  }
};

const dropSocket = (accountId) => {
  const state = sessions.get(accountId);
  if (!state) return;
  if (state.sock) {
    try {
      state.sock.ev.removeAllListeners();
      state.sock.end();
    } catch { /* already gone */ }
  }
  sessions.set(accountId, { ...blankState(), reconnectAttempts: state.reconnectAttempts });
};

/** Digits only; a leading 0 with no country code cannot be routed. */
export const toJid = (phone) => {
  const digits = String(phone).replace(/\D/g, "").replace(/^0+/, "");
  return digits ? `${digits}@s.whatsapp.net` : null;
};

const numberFromJid = (jid) => String(jid || "").split(":")[0].split("@")[0];

const isLid = (jid) => String(jid || "").includes("@lid");

/**
 * The real phone number behind an incoming message.
 *
 * WhatsApp is migrating to LID addressing: a chat that used to arrive as
 * `923189809338@s.whatsapp.net` now arrives as `244735927128289@lid`, where the
 * digits are an opaque account id and not a phone number at all. Reading the
 * number straight off `remoteJid` therefore silently stopped matching threads
 * for any contact WhatsApp had already migrated.
 *
 * `MessageKey` carries no phone-number field, so the only reliable route back is
 * the socket's own LID→PN store, which Baileys populates when the session is
 * established. Group messages additionally carry `participantPn`.
 *
 * Returns bare digits, or null when the LID cannot be resolved — in which case
 * the caller logs rather than dropping the message in silence.
 */
export const senderNumber = async (sock, msg) => {
  const raw = msg?.key?.remoteJid;
  if (!raw) return null;
  if (!isLid(raw)) return numberFromJid(raw) || null;

  // Group fan-out puts the sender's phone number on the event itself.
  if (msg.participantPn) return numberFromJid(msg.participantPn) || null;

  try {
    const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(raw);
    if (pn) return numberFromJid(pn) || null;
  } catch (err) {
    logger.debug({ jid: raw, msg: err.message }, "LID → phone lookup failed");
  }
  return null;
};

const markStatus = (accountId, data) =>
  prisma.whatsAppAccount.update({ where: { id: accountId }, data }).catch((err) =>
    logger.warn({ accountId, msg: err.message }, "could not persist WhatsApp account status"),
  );

// ─── Accounts ─────────────────────────────────────────────────────────────────

export const listWhatsAppAccounts = () =>
  prisma.whatsAppAccount.findMany({ orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });

/** Only one device may be the default; clear the flag everywhere else. */
export const applyWhatsAppDefault = async (accountId) => {
  await prisma.whatsAppAccount.updateMany({ where: { id: { not: accountId } }, data: { isDefault: false } });
  await prisma.whatsAppAccount.update({ where: { id: accountId }, data: { isDefault: true } });
};

/**
 * Resolve the device to send from: the one asked for, else the default, else
 * the first connected one. Falls back to *any* row so the caller can produce a
 * "pair it first" error rather than a confusing "no account".
 */
export const getWhatsAppAccount = async (accountId = null) => {
  if (accountId) return prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
  const connectedIds = [...sessions.entries()].filter(([, s]) => s.connected).map(([id]) => id);
  return (
    (await prisma.whatsAppAccount.findFirst({ where: { isDefault: true } })) ||
    (connectedIds.length
      ? await prisma.whatsAppAccount.findFirst({ where: { id: { in: connectedIds } } })
      : null) ||
    prisma.whatsAppAccount.findFirst({ orderBy: { createdAt: "asc" } })
  );
};

export const createWhatsAppAccount = async ({ label }) => {
  const isFirst = (await prisma.whatsAppAccount.count()) === 0;
  return prisma.whatsAppAccount.create({
    data: { label: label.trim().slice(0, 80), isDefault: isFirst },
  });
};

/** Unlink a device: log the socket out, wipe its credentials, drop the row. */
export const deleteWhatsAppAccount = async (accountId) => {
  await logoutWhatsApp(accountId).catch(() => {});
  sessions.delete(accountId);
  wipeCreds(accountId);
  const account = await prisma.whatsAppAccount.findUnique({ where: { id: accountId } });
  await prisma.whatsAppAccount.delete({ where: { id: accountId } });
  if (account?.isDefault) {
    const next = await prisma.whatsAppAccount.findFirst({ orderBy: { createdAt: "asc" } });
    if (next) await applyWhatsAppDefault(next.id);
  }
};

// ─── Incoming ─────────────────────────────────────────────────────────────────

/**
 * A message arriving from a number this device has an open thread with is a
 * reply: record it and stop any follow-up.
 *
 * Scoped to `waAccountId` — see the module note. A thread opened on the sales
 * phone must not be closed by a message that arrived on the personal one.
 */
const handleIncoming = async (accountId, messages, sock) => {
  for (const msg of messages || []) {
    try {
      if (!msg?.key || msg.key.fromMe) continue;
      const fromNumber = await senderNumber(sock, msg);
      if (!fromNumber) {
        logger.warn({ accountId, jid: msg.key.remoteJid }, "incoming WhatsApp message from an unresolvable address — reply not matched");
        continue;
      }
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        null;

      // recipientEmail stores the phone number on WHATSAPP threads; match on
      // the last 9 digits so local vs country-code formats still line up.
      const thread = await prisma.outreachThread.findFirst({
        where: {
          channel: "WHATSAPP",
          status: "AWAITING_REPLY",
          waAccountId: accountId,
          recipientEmail: { endsWith: fromNumber.slice(-9) },
        },
        orderBy: { updatedAt: "desc" },
      });
      if (!thread) {
        // Not an error: most incoming WhatsApp traffic is unrelated to outreach.
        // Logged anyway, because a *missed* reply looks exactly like this and
        // was previously invisible.
        logger.debug({ accountId, fromNumber }, "incoming WhatsApp message with no open thread — ignored");
        continue;
      }

      await prisma.outreachMessage.create({
        data: {
          threadId: thread.id,
          direction: "INBOUND",
          kind: "REPLY",
          subject: "WhatsApp reply",
          body: (text || "(non-text reply — open WhatsApp to view)").slice(0, 8000),
          messageId: msg.key.id || null,
          fromAddress: fromNumber,
          receivedAt: new Date(Number(msg.messageTimestamp) * 1000 || Date.now()),
        },
      });
      await prisma.outreachThread.update({
        where: { id: thread.id },
        data: { status: "REPLIED", repliedAt: new Date(), nextFollowUpAt: null },
      });
      // Same rule as the email side — see lib/outreach/leadStatus.js. Imported
      // lazily because whatsapp.js is loaded at boot to restore sockets, and a
      // static import would pull the scoring engine into that path.
      const { onReplyReceived } = await import("./leadStatus.js");
      await onReplyReceived({ leadId: thread.leadId, channel: "WHATSAPP", from: fromNumber, snippet: text });
      logger.info({ accountId, threadId: thread.id, fromNumber }, "WhatsApp reply recorded");
    } catch (err) {
      logger.warn({ accountId, msg: err.message }, "incoming WhatsApp message handling failed");
    }
  }
};

// ─── Connection ───────────────────────────────────────────────────────────────

/**
 * Bring one device's socket up. Resolves with whichever happens first: a QR to
 * scan, a ready connection, a terminal close reason, or the QR timeout.
 */
export const initializeConnection = async (accountId, forceNew = false) => {
  const state = stateFor(accountId);
  if (state.initializing) return { status: "initializing" };
  state.initializing = true;

  try {
    if (forceNew) {
      dropSocket(accountId);
      wipeCreds(accountId);
      stateFor(accountId).initializing = true;
    }
    fs.mkdirSync(authDir(accountId), { recursive: true });

    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir(accountId));
    const { version } = await fetchLatestBaileysVersion();

    return await new Promise((resolve) => {
      let resolved = false;
      const settle = (value) => {
        if (resolved) return;
        resolved = true;
        stateFor(accountId).initializing = false;
        resolve(value);
      };

      const sock = makeWASocket({
        version,
        logger: baileysLogger,
        printQRInTerminal: false,
        auth: { creds: authState.creds, keys: makeCacheableSignalKeyStore(authState.keys, baileysLogger) },
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        defaultQueryTimeoutMs: 60_000,
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        getMessage: async () => ({ conversation: "" }),
      });
      stateFor(accountId).sock = sock;

      sock.ev.on("creds.update", saveCreds);
      sock.ev.on("messages.upsert", ({ messages }) => handleIncoming(accountId, messages, sock));

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const s = stateFor(accountId);

        if (qr) {
          try {
            s.qr = await QRCode.toDataURL(qr);
            await markStatus(accountId, { status: "PAIRING", lastError: null });
            settle({ status: "qr", qrCode: s.qr });
          } catch (err) {
            logger.error({ accountId, msg: err.message }, "QR encoding failed");
          }
        }

        if (connection === "open") {
          s.connected = true;
          s.qr = null;
          s.reconnectAttempts = 0;
          if (sock.user) {
            s.user = {
              id: sock.user.id,
              name: sock.user.verifiedName || sock.user.notify || sock.user.name || "WhatsApp User",
              number: numberFromJid(sock.user.id),
            };
          }
          // The number is discovered here, never typed by the user. Two rows
          // may not claim the same phone, so a re-pair onto an already-linked
          // number keeps the row and just refreshes what it knows.
          await markStatus(accountId, {
            status: "CONNECTED",
            lastError: null,
            lastConnectedAt: new Date(),
            ...(s.user?.number ? { phoneNumber: s.user.number } : {}),
            ...(s.user?.name ? { pushName: s.user.name.slice(0, 120) } : {}),
          });
          logger.info({ accountId, number: s.user?.number }, "WhatsApp connected");
          settle({ status: "ready", user: s.user });
        }

        if (connection === "close") {
          const statusCode =
            lastDisconnect?.error?.output?.statusCode ||
            lastDisconnect?.error?.output?.payload?.statusCode;
          s.connected = false;
          s.qr = null;

          if (s.intentionalLogout || statusCode === DisconnectReason.loggedOut) {
            dropSocket(accountId);
            wipeCreds(accountId);
            await markStatus(accountId, { status: "DISCONNECTED", phoneNumber: null });
            settle({ status: "logged_out", needsQR: true });
            return;
          }
          if (statusCode === DisconnectReason.connectionReplaced) {
            await markStatus(accountId, {
              status: "ERROR",
              lastError: "This device was linked somewhere else — pair it again to send from here.",
            });
            settle({ status: "replaced" });
            return;
          }
          // Transient closes get a few automatic reconnects.
          s.reconnectAttempts += 1;
          if (s.reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
            const attempts = s.reconnectAttempts;
            dropSocket(accountId);
            stateFor(accountId).reconnectAttempts = attempts;
            setTimeout(() => { initializeConnection(accountId, false).catch(() => {}); }, 3000);
          } else {
            dropSocket(accountId);
            await markStatus(accountId, { status: "DISCONNECTED" });
            settle({ status: "disconnected", needsQR: true });
          }
        }
      });

      setTimeout(() => settle({ status: "timeout", needsQR: true }), QR_WAIT_MS);
    });
  } catch (err) {
    stateFor(accountId).initializing = false;
    logger.error({ accountId, msg: err.message }, "WhatsApp initialization failed");
    await markStatus(accountId, { status: "ERROR", lastError: String(err.message).slice(0, 500) });
    return { status: "error", error: err.message };
  }
};

/** The connect/QR endpoint's whole answer for one device, in one call. */
export const checkSession = async (accountId, { forceNew = false } = {}) => {
  const state = stateFor(accountId);
  if (state.connected && state.sock && !forceNew) return { status: "connected", user: state.user };
  if (!forceNew && state.qr) return { status: "qr_required", qrCode: state.qr };

  const result = await initializeConnection(accountId, forceNew);
  if (result.status === "ready") return { status: "connected", user: stateFor(accountId).user };
  if (result.status === "qr") return { status: "qr_required", qrCode: result.qrCode };
  if (result.status === "initializing") return { status: "initializing" };
  return { status: "disconnected", detail: result.status, error: result.error || null };
};

export const logoutWhatsApp = async (accountId) => {
  const state = stateFor(accountId);
  state.intentionalLogout = true;
  try {
    await state.sock?.logout();
  } catch { /* session may already be dead */ }
  dropSocket(accountId);
  wipeCreds(accountId);
  await markStatus(accountId, { status: "DISCONNECTED", phoneNumber: null }).catch(() => {});
  return { ok: true };
};

/** Live state for one device, merged with what the DB row remembers. */
export const whatsappAccountStatus = (account) => {
  const state = sessions.get(account.id) || blankState();
  return {
    id: account.id,
    label: account.label,
    isDefault: account.isDefault,
    phoneNumber: account.phoneNumber,
    pushName: account.pushName,
    status: account.status,
    lastError: account.lastError,
    lastConnectedAt: account.lastConnectedAt,
    createdAt: account.createdAt,
    autoFollowUp: account.autoFollowUp,
    followUpDays: account.followUpDays,
    maxFollowUps: account.maxFollowUps,
    connected: state.connected,
    // A stored credential folder means the pairing survives a restart, so the
    // UI can say "reconnecting" instead of "not paired" while it comes back up.
    hasSession: hasCreds(account.id),
    pendingQr: Boolean(state.qr),
    user: state.user,
  };
};

/** Every device with its live state. */
export const whatsappStatusAll = async () => {
  const accounts = await listWhatsAppAccounts();
  const devices = accounts.map(whatsappAccountStatus);
  return {
    accounts: devices,
    // Kept for the pre-multi-device shape of this endpoint: true when *any*
    // device can send right now.
    connected: devices.some((d) => d.connected),
    user: devices.find((d) => d.connected)?.user || null,
    hasSession: devices.some((d) => d.hasSession),
  };
};

/** Send one text message from one device. The caller owns thread bookkeeping. */
export const sendWhatsAppText = async ({ accountId, phone, text }) => {
  const state = sessions.get(accountId);
  if (!state?.connected || !state.sock) {
    return { ok: false, error: "That WhatsApp device is not connected. Pair it in Settings first." };
  }
  const jid = toJid(phone);
  if (!jid) return { ok: false, error: "That phone number cannot be used on WhatsApp (include the country code)." };

  try {
    // Verify the number is actually registered before sending into the void.
    const [check] = await state.sock.onWhatsApp(jid);
    if (!check?.exists) return { ok: false, error: `${phone} is not registered on WhatsApp.` };
    const sent = await state.sock.sendMessage(check.jid, { text });
    return { ok: true, messageId: sent?.key?.id || null, jid: check.jid };
  } catch (err) {
    logger.error({ accountId, phone, msg: err.message }, "WhatsApp send failed");
    return { ok: false, error: err.message };
  }
};

// ─── Boot ─────────────────────────────────────────────────────────────────────

/**
 * Move a pre-multi-device credential folder into a real account.
 *
 * The old layout kept creds.json directly under .baileys_auth. Rehoming it
 * under an account id means an existing pairing survives this change — the
 * alternative is silently asking the user to re-scan a QR they already scanned.
 */
const migrateLegacySession = async () => {
  const legacyCreds = path.join(AUTH_ROOT, "creds.json");
  if (!fs.existsSync(legacyCreds)) return;

  const account =
    (await prisma.whatsAppAccount.findFirst({ orderBy: { createdAt: "asc" } })) ||
    (await prisma.whatsAppAccount.create({ data: { label: "WhatsApp", isDefault: true } }));

  if (hasCreds(account.id)) return; // already migrated; leave the stray files
  fs.mkdirSync(authDir(account.id), { recursive: true });
  for (const entry of fs.readdirSync(AUTH_ROOT, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    fs.renameSync(path.join(AUTH_ROOT, entry.name), path.join(authDir(account.id), entry.name));
  }
  logger.info({ accountId: account.id }, "migrated the pre-multi-device WhatsApp session");
};

/**
 * Restore every device that was paired before the process restarted.
 *
 * Called explicitly from index.js rather than on import, and *only* there. The
 * worker imports this module too (through the outreach service), and if both
 * processes opened a socket for the same device WhatsApp would keep evicting
 * one with `connectionReplaced` while they fought over the pairing. The API
 * owns the sockets; the worker only ever sends email.
 */
export const restoreSessions = async () => {
  try {
    fs.mkdirSync(AUTH_ROOT, { recursive: true });
    await migrateLegacySession();
    for (const account of await listWhatsAppAccounts()) {
      if (!hasCreds(account.id)) continue;
      initializeConnection(account.id, false).catch((err) =>
        logger.warn({ accountId: account.id, msg: err.message }, "WhatsApp auto-restore failed"),
      );
    }
  } catch (err) {
    logger.warn({ msg: err.message }, "WhatsApp session restore skipped");
  }
};

const shutdown = () => { for (const id of sessions.keys()) dropSocket(id); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
