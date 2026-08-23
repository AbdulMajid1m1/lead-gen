import { describe, it, expect } from "vitest";
import { isBlockedAddress, isBlockedHostname } from "../../lib/crawler/ipGuard.js";

/**
 * The SSRF guard is the single control standing between third-party-supplied
 * URLs and this server's own network, so it gets the most adversarial tests in
 * the suite. A false negative here is a security incident.
 */
describe("isBlockedAddress", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback range"],
    ["10.0.0.1", "RFC1918 /8"],
    ["172.16.0.1", "RFC1918 /12 lower bound"],
    ["172.31.255.255", "RFC1918 /12 upper bound"],
    ["192.168.1.1", "RFC1918 /16"],
    ["169.254.169.254", "cloud metadata endpoint"],
    ["100.64.0.1", "CGNAT"],
    ["0.0.0.0", "this network"],
    ["192.0.2.1", "TEST-NET-1"],
    ["198.51.100.1", "TEST-NET-2"],
    ["203.0.113.1", "TEST-NET-3"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
  ])("blocks %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ["8.8.8.8"],
    ["1.1.1.1"],
    ["93.184.216.34"],
    ["172.15.255.255"], // just outside RFC1918 /12
    ["172.32.0.1"],     // just outside RFC1918 /12
    ["11.0.0.1"],       // just outside 10/8
  ])("allows public address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each([
    ["::1", "IPv6 loopback"],
    ["::", "unspecified"],
    ["fc00::1", "unique local"],
    ["fd12:3456::1", "unique local"],
    ["fe80::1", "link local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["64:ff9b::1", "NAT64"],
  ])("blocks IPv6 %s (%s)", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 wrappers of private space", () => {
    // ::ffff:127.0.0.1 is the classic bypass — a v6 literal that resolves to
    // loopback. It must be judged by the v4 rules.
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:10.0.0.1")).toBe(true);
  });

  it("allows an IPv4-mapped public address", () => {
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("blocks 6to4 wrappers of private space", () => {
    // 2002:a00:1:: embeds 10.0.0.1
    expect(isBlockedAddress("2002:a00:0001::")).toBe(true);
  });

  it("allows a public IPv6 address", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("refuses anything unparseable rather than defaulting to allow", () => {
    for (const bad of ["", null, undefined, "not-an-ip", "999.999.999.999", "1.2.3", "::gggg", 42]) {
      expect(isBlockedAddress(bad)).toBe(true);
    }
  });
});

describe("isBlockedHostname", () => {
  it.each(["localhost", "LOCALHOST", "localhost.", "metadata.google.internal", "instance-data"])(
    "blocks well-known internal hostname %s",
    (host) => expect(isBlockedHostname(host)).toBe(true),
  );

  it.each(["printer.local", "db.internal", "site.test", "foo.onion", "x.home.arpa"])(
    "blocks internal TLD %s",
    (host) => expect(isBlockedHostname(host)).toBe(true),
  );

  it("blocks a bare private IP used as a hostname", () => {
    expect(isBlockedHostname("192.168.0.1")).toBe(true);
    expect(isBlockedHostname("::1")).toBe(true);
  });

  it("allows ordinary public hostnames", () => {
    for (const host of ["example.com", "www.acme.co.uk", "sub.domain.example.org"]) {
      expect(isBlockedHostname(host)).toBe(false);
    }
  });
});
