/**
 * SSRF address guard.
 *
 * The crawler fetches URLs that ultimately originate from third-party data
 * (OpenStreetMap tags, job boards, page links). Any of those can point at
 * `http://169.254.169.254/latest/meta-data/` or `http://127.0.0.1:5433`. This
 * module is the single place that decides whether an address is allowed to be
 * connected to, and it is enforced at *connect* time (see safeFetch.js) so a
 * DNS-rebinding answer cannot slip past a pre-flight check.
 */

/** Parse a dotted-quad into a 32-bit unsigned int, or null if not IPv4. */
const v4ToInt = (ip) => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8) + n;
  }
  return out >>> 0;
};

const cidr4 = (base, bits) => {
  const b = v4ToInt(base);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (b & mask) >>> 0, mask };
};

// Everything that is not a public, routable unicast destination.
const BLOCKED_V4 = [
  cidr4("0.0.0.0", 8),          // "this" network
  cidr4("10.0.0.0", 8),         // RFC1918
  cidr4("100.64.0.0", 10),      // CGNAT
  cidr4("127.0.0.0", 8),        // loopback
  cidr4("169.254.0.0", 16),     // link-local — cloud metadata lives here
  cidr4("172.16.0.0", 12),      // RFC1918
  cidr4("192.0.0.0", 24),       // IETF protocol assignments
  cidr4("192.0.2.0", 24),       // TEST-NET-1
  cidr4("192.168.0.0", 16),     // RFC1918
  cidr4("198.18.0.0", 15),      // benchmarking
  cidr4("198.51.100.0", 24),    // TEST-NET-2
  cidr4("203.0.113.0", 24),     // TEST-NET-3
  cidr4("224.0.0.0", 4),        // multicast
  cidr4("240.0.0.0", 4),        // reserved + broadcast
];

const isBlockedV4 = (ip) => {
  const n = v4ToInt(ip);
  if (n === null) return true; // unparseable → refuse
  return BLOCKED_V4.some(({ net, mask }) => ((n & mask) >>> 0) === net);
};

/** Expand an IPv6 literal into 8 numeric groups, or null if malformed. */
const expandV6 = (input) => {
  let ip = input.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!ip.includes(":")) return null;

  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const parseSide = (side) => (side ? side.split(":").filter((p) => p !== "") : []);
  const head = parseSide(halves[0]);
  const tail = halves.length === 2 ? parseSide(halves[1]) : [];

  // A trailing IPv4 literal (::ffff:1.2.3.4) expands into two groups.
  const expandTail = (arr) => {
    const out = [];
    for (const part of arr) {
      if (part.includes(".")) {
        const n = v4ToInt(part);
        if (n === null) return null;
        out.push((n >>> 16) & 0xffff, n & 0xffff);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        out.push(Number.parseInt(part, 16));
      }
    }
    return out;
  };

  const h = expandTail(head);
  const t = expandTail(tail);
  if (h === null || t === null) return null;

  if (halves.length === 2) {
    const fill = 8 - h.length - t.length;
    if (fill < 0) return null;
    return [...h, ...Array(fill).fill(0), ...t];
  }
  return h.length === 8 ? h : null;
};

const isBlockedV6 = (ip) => {
  const g = expandV6(ip);
  if (!g) return true;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — judge by the v4 rules,
  // otherwise `http://[::ffff:127.0.0.1]/` walks straight into loopback.
  const firstSixZero = g.slice(0, 5).every((x) => x === 0);
  if (firstSixZero && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
    // `::` and `::1` themselves are unspecified/loopback → blocked anyway.
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true;
    return isBlockedV4(v4);
  }

  const first = g[0];
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (first === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 doc
  if (first === 0x0064 && g[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64
  if (first === 0x2002) {
    // 6to4 — the embedded v4 decides.
    const v4 = `${(g[1] >> 8) & 0xff}.${g[1] & 0xff}.${(g[2] >> 8) & 0xff}.${g[2] & 0xff}`;
    return isBlockedV4(v4);
  }
  return false;
};

/**
 * @param {string} address  a numeric IP (never a hostname)
 * @returns {boolean} true when the crawler must refuse to connect
 */
export const isBlockedAddress = (address) => {
  if (!address || typeof address !== "string") return true;
  return address.includes(":") ? isBlockedV6(address) : isBlockedV4(address);
};

/** Hostnames that must never be resolved, regardless of what DNS says. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback",
  "metadata", "metadata.google.internal", "instance-data",
]);

const BLOCKED_TLDS = [".local", ".internal", ".localhost", ".home.arpa", ".onion", ".test", ".invalid"];

export const isBlockedHostname = (hostname) => {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (BLOCKED_TLDS.some((tld) => h.endsWith(tld))) return true;
  // A bare IP in the host position skips DNS entirely — check it directly.
  if (/^[\d.]+$/.test(h) || h.includes(":")) return isBlockedAddress(h);
  return false;
};
