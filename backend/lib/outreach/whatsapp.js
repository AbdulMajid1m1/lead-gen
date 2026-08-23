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
 * WhatsApp sending over Baileys — a pure WebSocket client, no browser needed,
 * ported from the SLIC_POS implementation. One device pairs by scanning a QR
 * code; credentials persist in AUTH_FOLDER so the session survives restarts.
 *
 * Improvements over the reference: incoming messages from contacts we have
 * open threads with are recorded as replies in real time (the reference was
 * send-only), and every send lands in the same OutreachThread/OutreachMessage
 * tables as email, so the UI shows one conversation history per lead.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTH_FOLDER = process.env.WHATSAPP_AUTH_DIR || path.join(here, "../../.baileys_auth");
const MAX_RECONNECT_ATTEMPTS = 3;

const baileysLogger = pino({ level: "silent" });

let sock = null;
let isConnected = false;
let currentQRCodeDataURL = null;
let isIntentionalLogout = false;
let initializationInProgress = false;
let userInfo = null;
let reconnectAttempts = 0;

const cleanupAuthFolder = () => {
  try {
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  } catch (err) {
    logger.warn({ msg: err.message }, "could not clean auth folder");
  }
};

const hasExistingSession = () => fs.existsSync(path.join(AUTH_FOLDER, "creds.json"));

const quickDisconnect = () => {
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end();
    } catch { /* already gone */ }
    sock = null;
  }
  isConnected = false;
  currentQRCodeDataURL = null;
  userInfo = null;
  initializationInProgress = false;
};

/** Digits only; a leading 0 with no country code cannot be routed. */
export const toJid = (phone) => {
  const digits = String(phone).replace(/\D/g, "").replace(/^0+/, "");
  return digits ? `${digits}@s.whatsapp.net` : null;
};

const numberFromJid = (jid) => String(jid || "").split(":")[0].split("@")[0];

/**
 * A message arriving from a number we have an open WhatsApp thread with is a
 * reply: record it and stop any follow-up.
 */
const handleIncoming = async (messages) => {
  for (const msg of messages || []) {
    try {
      if (!msg?.key || msg.key.fromMe) continue;
      const fromNumber = numberFromJid(msg.key.remoteJid);
      if (!fromNumber) continue;
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
          recipientEmail: { endsWith: fromNumber.slice(-9) },
        },
        orderBy: { updatedAt: "desc" },
      });
      if (!thread) continue;

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
      await prisma.leadStatusHistory.create({
        data: {
          leadId: thread.leadId,
          fromStatus: null,
          toStatus: "FOLLOW_UP",
          note: `WhatsApp reply from ${fromNumber}: "${(text || "").slice(0, 120)}"`,
        },
      });
      logger.info({ threadId: thread.id, fromNumber }, "WhatsApp reply recorded");
    } catch (err) {
      logger.warn({ msg: err.message }, "incoming WhatsApp message handling failed");
    }
  }
};

/**
 * Bring the socket up. Resolves with whichever happens first: a QR to scan,
 * a ready connection, a terminal close reason, or a 60s timeout.
 */
export const initializeConnection = async (forceNew = false) => {
  if (initializationInProgress) return { status: "initializing" };
  initializationInProgress = true;

  try {
    if (forceNew) {
      quickDisconnect();
      cleanupAuthFolder();
    }
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    return await new Promise((resolve) => {
      let resolved = false;
      const settle = (value) => {
        if (!resolved) {
          resolved = true;
          initializationInProgress = false;
          resolve(value);
        }
      };

      sock = makeWASocket({
        version,
        logger: baileysLogger,
        printQRInTerminal: false,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        defaultQueryTimeoutMs: 60_000,
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        getMessage: async () => ({ conversation: "" }),
      });

      sock.ev.on("creds.update", saveCreds);
      sock.ev.on("messages.upsert", ({ messages }) => handleIncoming(messages));

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            currentQRCodeDataURL = await QRCode.toDataURL(qr);
            settle({ status: "qr", qrCode: currentQRCodeDataURL });
          } catch (err) {
            logger.error({ msg: err.message }, "QR encoding failed");
          }
        }

        if (connection === "open") {
          isConnected = true;
          currentQRCodeDataURL = null;
          reconnectAttempts = 0;
          if (sock.user) {
            userInfo = {
              id: sock.user.id,
              name: sock.user.verifiedName || sock.user.notify || sock.user.name || "WhatsApp User",
              number: numberFromJid(sock.user.id),
            };
          }
          logger.info({ number: userInfo?.number }, "WhatsApp connected");
          settle({ status: "ready", user: userInfo });
        }

        if (connection === "close") {
          const statusCode =
            lastDisconnect?.error?.output?.statusCode ||
            lastDisconnect?.error?.output?.payload?.statusCode;
          isConnected = false;
          currentQRCodeDataURL = null;

          if (isIntentionalLogout) {
            cleanupAuthFolder();
            isIntentionalLogout = false;
            reconnectAttempts = 0;
            settle({ status: "logged_out", needsQR: true });
            return;
          }
          if (statusCode === DisconnectReason.loggedOut) {
            cleanupAuthFolder();
            reconnectAttempts = 0;
            settle({ status: "logged_out", needsQR: true });
            return;
          }
          if (statusCode === DisconnectReason.connectionReplaced) {
            settle({ status: "replaced" });
            return;
          }
          // Transient closes get a few automatic reconnects.
          reconnectAttempts += 1;
          if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
            quickDisconnect();
            setTimeout(() => { initializeConnection(false).catch(() => {}); }, 3000);
          } else {
            quickDisconnect();
            settle({ status: "disconnected", needsQR: true });
          }
        }
      });

      setTimeout(() => settle({ status: "timeout", needsQR: true }), 60_000);
    });
  } catch (err) {
    initializationInProgress = false;
    logger.error({ msg: err.message }, "WhatsApp initialization failed");
    return { status: "error", error: err.message };
  }
};

/** The connect/QR endpoint's whole answer in one call. */
export const checkSession = async ({ forceNew = false } = {}) => {
  if (isConnected && sock && !forceNew) {
    return { status: "connected", user: userInfo };
  }
  if (!forceNew && currentQRCodeDataURL) {
    return { status: "qr_required", qrCode: currentQRCodeDataURL };
  }
  const result = await initializeConnection(forceNew || !hasExistingSession() ? forceNew : false);
  if (result.status === "ready") return { status: "connected", user: userInfo };
  if (result.status === "qr") return { status: "qr_required", qrCode: result.qrCode };
  if (result.status === "initializing") return { status: "initializing" };
  return { status: "disconnected", detail: result.status, error: result.error || null };
};

export const logout = async () => {
  isIntentionalLogout = true;
  try {
    await sock?.logout();
  } catch { /* session may already be dead */ }
  quickDisconnect();
  cleanupAuthFolder();
  isIntentionalLogout = false;
  return { ok: true };
};

export const whatsappStatus = () => ({
  connected: isConnected,
  user: userInfo,
  hasSession: hasExistingSession(),
});

/** Send one text message. The caller owns thread bookkeeping. */
export const sendWhatsAppText = async ({ phone, text }) => {
  if (!isConnected || !sock) {
    return { ok: false, error: "WhatsApp is not connected. Pair the device in Settings first." };
  }
  const jid = toJid(phone);
  if (!jid) return { ok: false, error: "That phone number cannot be used on WhatsApp (include the country code)." };

  try {
    // Verify the number is actually registered before sending into the void.
    const [check] = await sock.onWhatsApp(jid);
    if (!check?.exists) return { ok: false, error: `${phone} is not registered on WhatsApp.` };
    const sent = await sock.sendMessage(check.jid, { text });
    return { ok: true, messageId: sent?.key?.id || null, jid: check.jid };
  } catch (err) {
    logger.error({ phone, msg: err.message }, "WhatsApp send failed");
    return { ok: false, error: err.message };
  }
};

/** Restore the session on boot when the device was paired before. */
if (hasExistingSession()) {
  setTimeout(() => {
    initializeConnection(false).catch((err) =>
      logger.warn({ msg: err.message }, "WhatsApp auto-restore failed"),
    );
  }, 3000);
}

process.on("SIGINT", () => quickDisconnect());
process.on("SIGTERM", () => quickDisconnect());
