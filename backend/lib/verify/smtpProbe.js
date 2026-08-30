import net from "node:net";
import dns from "node:dns/promises";
import crypto from "node:crypto";
import {
  SMTP_PROBE_ENABLED, SMTP_PROBE_HELO_DOMAIN, SMTP_PROBE_FROM, SMTP_PROBE_TIMEOUT_MS,
} from "../../configs/envConfig.js";
import { log } from "../../utils/logger.js";

const logger = log("verify:smtpProbe");

/**
 * SMTP-level mailbox verification — RCPT TO without ever sending a message.
 *
 * The MX check in hygiene.js answers "can this domain receive mail at all";
 * this module answers the question that actually protects bounce rate: "does
 * this *mailbox* exist". Independent tests of contact databases put their
 * bounce rates at 28–38%; past ~4% a sending domain starts getting
 * junk-foldered wholesale, and past ~5% the practical fix is a new domain and
 * months of warm-up. plan.md names SMTP verification the single
 * highest-ROI addition to the pipeline. This is that addition, done natively —
 * no vendor, no API key, no lead data leaving the machine.
 *
 * The conversation is the minimum the RFC allows before the DATA phase, which
 * is the line this module never crosses:
 *
 *   EHLO <heloDomain> → MAIL FROM:<probe> → RCPT TO:<target> → RCPT TO:<random> → QUIT
 *
 * The random second RCPT is the catch-all detector: a server that accepts a
 * mailbox that cannot exist accepts everything, so its "yes" for the target
 * means nothing.
 *
 * Semantics are strictly fail-open. Only a definitive, mailbox-level 5xx may
 * condemn an address. Everything ambiguous — greylisting (4xx), a
 * policy/reputation rejection (5.7.x, "blocked", "spamhaus"), a timeout, a
 * closed port 25 (most clouds block outbound 25 by default) — is
 * INCONCLUSIVE, and an inconclusive address stays sendable. A wrongly
 * suppressed real lead costs more than a bounce.
 */

/** @typedef {"DELIVERABLE"|"UNDELIVERABLE"|"ACCEPT_ALL"|"INCONCLUSIVE"} ProbeVerdict */

// ─── Reply interpretation ────────────────────────────────────────────────────

/**
 * A 5xx that is about the *mailbox* rather than about us. Enhanced status
 * 5.1.x is "bad destination mailbox" by RFC 3463; the word patterns cover
 * servers that send bare 550s with prose.
 */
const MAILBOX_REJECT_RE =
  /\b5\.1\.[0-9]\b|user unknown|unknown user|mailbox (?:unavailable|not found|does not exist|disabled|full)|no such (?:user|recipient|mailbox|address)|recipient (?:not found|unknown|rejected|address rejected)|address (?:unknown|not found|does not exist)|invalid (?:recipient|mailbox|address)|no mailbox/i;

/**
 * A 5xx that is about our connection, not the mailbox: IP reputation, missing
 * rDNS, policy filters. Treating these as "mailbox does not exist" would
 * suppress every contact behind a strict filter — from a cold probe IP that
 * can be *all* of them.
 */
const POLICY_REJECT_RE =
  /\b5\.7\.[0-9]+\b|spamhaus|spamcop|barracuda|blocklist|blacklist|black list|blocked|banned|denied|policy|reputation|rdns|reverse dns|ptr record|spf|dkim|dmarc|relay(?:ing)? (?:denied|not)|access denied|too many|rate limit|greylist|listed at/i;

/**
 * Read one RCPT TO reply.
 * @returns {"ACCEPT"|"REJECT_MAILBOX"|"REJECT_POLICY"|"TEMPFAIL"}
 */
export const interpretRcptReply = (code, text = "") => {
  if (code >= 200 && code < 300) return "ACCEPT";
  if (code >= 400 && code < 500) return "TEMPFAIL";
  if (code >= 500) {
    if (POLICY_REJECT_RE.test(text)) return "REJECT_POLICY";
    if (MAILBOX_REJECT_RE.test(text)) return "REJECT_MAILBOX";
    // A bare "550 rejected" with no reason: 550/551/553 default to a mailbox
    // statement (that is what the codes mean); 554 is the generic "transaction
    // failed" servers use for policy, so it stays inconclusive.
    return code === 554 ? "REJECT_POLICY" : "REJECT_MAILBOX";
  }
  return "TEMPFAIL";
};

/**
 * Combine the target's RCPT outcome with the random probe's into a verdict.
 * @returns {ProbeVerdict}
 */
export const combineVerdicts = (target, random) => {
  if (target === "REJECT_MAILBOX") return "UNDELIVERABLE";
  if (target === "ACCEPT") {
    if (random === "ACCEPT") return "ACCEPT_ALL";
    if (random === "REJECT_MAILBOX") return "DELIVERABLE";
    // Random probe tempfailed or was policy-rejected: the target's "yes"
    // stands, but uncorroborated — call it deliverable, not verified-strong.
    return "DELIVERABLE";
  }
  return "INCONCLUSIVE"; // TEMPFAIL or REJECT_POLICY on the target
};

// ─── Wire protocol ───────────────────────────────────────────────────────────

/**
 * Parse one (possibly multi-line) SMTP reply out of a buffer. Only lines that
 * are newline-terminated count — a TCP chunk can end mid-line, and "250 O"
 * must not be read as a complete "250 OK".
 */
const takeReply = (buffer) => {
  let idx = 0;
  for (;;) {
    const nl = buffer.indexOf("\n", idx);
    if (nl < 0) return null; // reply not complete yet
    const line = buffer.slice(idx, nl).replace(/\r$/, "");
    idx = nl + 1;
    const m = /^(\d{3})([ -])/.exec(line);
    // A "250-" line is a continuation; anything unparseable is noise. Both are
    // skipped — the reply ends at the "250 " (space-separated) line.
    if (m && m[2] === " ") return { code: Number(m[1]), text: line, rest: buffer.slice(idx) };
  }
};

/**
 * Run a fixed SMTP dialogue against one host. Commands are sent one at a
 * time, each after the previous reply; the replies come back in order.
 * Any socket error or timeout resolves with what was gathered — never throws.
 */
const smtpDialogue = (host, commands, { timeoutMs }) =>
  new Promise((resolve) => {
    const replies = [];
    let buffer = "";
    let sent = -1; // -1: waiting for the greeting banner
    let settled = false;

    const socket = net.createConnection({ host, port: 25 });
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ replies, error });
    };

    socket.setTimeout(timeoutMs, () => finish("timeout"));
    socket.on("error", (err) => finish(err.code || err.message));
    socket.on("close", () => finish("closed"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let reply;
      while ((reply = takeReply(buffer))) {
        buffer = reply.rest;
        replies.push({ code: reply.code, text: reply.text });
        sent += 1;
        if (sent >= commands.length) return finish();
        socket.write(`${commands[sent]}\r\n`);
      }
    });
  });

// ─── Caching ─────────────────────────────────────────────────────────────────

/** Per-address verdicts, kept for the life of the process. */
const addressCache = new Map();
/** Per-domain knowledge: catch-all status, and hosts we could not reach. */
const domainCache = new Map();

const UNREACHABLE_TTL_MS = 60 * 60 * 1000; // do not re-dial a dead host for an hour

const randomLocalPart = () => `zx-${crypto.randomBytes(9).toString("hex")}`;

// ─── Public API ──────────────────────────────────────────────────────────────

export const isSmtpProbeAvailable = () => SMTP_PROBE_ENABLED;

/**
 * Verify one mailbox over SMTP.
 *
 * @param {string} email
 * @returns {Promise<{verdict: ProbeVerdict, detail: string}>}
 */
export const probeMailbox = async (email) => {
  const address = String(email || "").trim().toLowerCase();
  const domain = address.split("@")[1];
  if (!SMTP_PROBE_ENABLED) return { verdict: "INCONCLUSIVE", detail: "SMTP probing is disabled." };
  if (!domain) return { verdict: "UNDELIVERABLE", detail: "Not a well-formed address." };

  if (addressCache.has(address)) return addressCache.get(address);

  const domainState = domainCache.get(domain) || {};
  if (domainState.catchAll) {
    const result = { verdict: "ACCEPT_ALL", detail: `${domain} accepts every recipient — a probe proves nothing.` };
    addressCache.set(address, result);
    return result;
  }
  if (domainState.unreachableUntil && Date.now() < domainState.unreachableUntil) {
    return { verdict: "INCONCLUSIVE", detail: `${domain}'s mail host was unreachable recently — not re-dialling yet.` };
  }

  let mxHost;
  try {
    const records = await dns.resolveMx(domain);
    mxHost = records.sort((a, b) => a.priority - b.priority)[0]?.exchange;
  } catch {
    return { verdict: "INCONCLUSIVE", detail: "MX lookup failed — hygiene's own MX gate owns that call." };
  }
  if (!mxHost) return { verdict: "INCONCLUSIVE", detail: "Domain publishes no MX exchange." };

  const heloDomain = SMTP_PROBE_HELO_DOMAIN || "localhost";
  const from = SMTP_PROBE_FROM || `probe@${heloDomain}`;
  const { replies, error } = await smtpDialogue(mxHost, [
    `EHLO ${heloDomain}`,
    `MAIL FROM:<${from}>`,
    `RCPT TO:<${address}>`,
    `RCPT TO:<${randomLocalPart()}@${domain}>`,
    "QUIT",
  ], { timeoutMs: SMTP_PROBE_TIMEOUT_MS });

  // replies: [banner, ehlo, mail-from, rcpt-target, rcpt-random, quit]
  const rcptTarget = replies[3];
  const rcptRandom = replies[4];

  if (!rcptTarget) {
    // Never got as far as the target RCPT: closed port, dropped banner,
    // rejected EHLO/MAIL FROM. All say nothing about the mailbox.
    domainCache.set(domain, { ...domainState, unreachableUntil: Date.now() + UNREACHABLE_TTL_MS });
    logger.debug({ domain, mxHost, error, got: replies.length }, "probe could not reach RCPT stage");
    return { verdict: "INCONCLUSIVE", detail: `Could not complete an SMTP dialogue with ${mxHost} (${error || "connection ended"}).` };
  }

  const target = interpretRcptReply(rcptTarget.code, rcptTarget.text);
  const random = rcptRandom ? interpretRcptReply(rcptRandom.code, rcptRandom.text) : "TEMPFAIL";
  const verdict = combineVerdicts(target, random);

  if (verdict === "ACCEPT_ALL") domainCache.set(domain, { ...domainState, catchAll: true });

  const result = {
    verdict,
    detail: `${mxHost} answered "${rcptTarget.text.slice(0, 200)}"${verdict === "ACCEPT_ALL" ? " — and accepted a random mailbox too, so the domain is catch-all." : ""}`,
  };
  addressCache.set(address, result);
  logger.info({ address, verdict, code: rcptTarget.code }, "mailbox probed");
  return result;
};

export const __testables = { interpretRcptReply, combineVerdicts, takeReply };
