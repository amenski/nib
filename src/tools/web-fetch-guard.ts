/**
 * Pure SSRF helpers for web_fetch, kept dependency-free (no imports at all, no
 * DNS, no network) so they can be unit-tested in isolation. web-fetch.ts owns
 * the actual DNS resolution and calls isBlockedAddress per resolved IP.
 *
 * The control-character sanitizer that used to sit here now lives only in
 * untrusted-content.ts — the shared module its consumers already import, and the
 * home security-spec.md T14 names for it. It is a pure string transform, so a
 * second copy narrowed nothing; this module keeps zero imports either way.
 */

function ipv4ToInt(a: number, b: number, c: number, d: number): number {
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** [network, prefixLength] pairs — IPv4 ranges that must never be reachable via web_fetch. */
const BLOCKED_V4_RANGES: Array<[number, number]> = [
  [ipv4ToInt(127, 0, 0, 0), 8], // loopback
  [ipv4ToInt(10, 0, 0, 0), 8], // private
  [ipv4ToInt(172, 16, 0, 0), 12], // private
  [ipv4ToInt(192, 168, 0, 0), 16], // private
  [ipv4ToInt(169, 254, 0, 0), 16], // link-local incl. cloud metadata (169.254.169.254)
  [ipv4ToInt(0, 0, 0, 0), 8], // "this network" / unspecified
];

function parseIpv4(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1, 5).map(Number);
  if (parts.some((p) => p < 0 || p > 255)) return null;
  return ipv4ToInt(parts[0], parts[1], parts[2], parts[3]);
}

function isBlockedV4(ip: number): boolean {
  return BLOCKED_V4_RANGES.some(([net, prefixLen]) => {
    const mask = prefixLen === 0 ? 0 : (0xffffffff << (32 - prefixLen)) >>> 0;
    return (ip & mask) === (net & mask);
  });
}

/**
 * Parses an IPv6 address (including "::" compression) into 8 16-bit groups,
 * or null if malformed. Deliberately minimal — only what's needed to classify
 * against the blocked ranges below.
 */
function parseIpv6(host: string): number[] | null {
  let addr = host;
  // Strip zone id (e.g. "fe80::1%eth0").
  const pctIdx = addr.indexOf("%");
  if (pctIdx !== -1) addr = addr.slice(0, pctIdx);

  // Trailing IPv4 dotted-quad notation (e.g. "::ffff:127.0.0.1") — rewrite
  // the last segment into its two equivalent hex groups so the rest of the
  // parser only ever deals with plain hex groups.
  const lastColon = addr.lastIndexOf(":");
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(addr.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  if (addr === "::") return new Array(8).fill(0);

  const parts = addr.split("::");
  if (parts.length > 2) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const groups = s.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  if (parts.length === 1) {
    const groups = parseGroups(parts[0]);
    if (!groups || groups.length !== 8) return null;
    return groups;
  }

  const head = parseGroups(parts[0]);
  const tail = parseGroups(parts[1]);
  if (!head || !tail) return null;
  const fillLen = 8 - head.length - tail.length;
  if (fillLen < 0) return null;
  return [...head, ...new Array(fillLen).fill(0), ...tail];
}

function isBlockedV6(groups: number[]): boolean {
  // ::1 — loopback
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;
  // ::ffff:a.b.c.d — IPv4-mapped: check the mapped v4 address against v4 ranges.
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    const a = (groups[6] >> 8) & 0xff;
    const b = groups[6] & 0xff;
    const c = (groups[7] >> 8) & 0xff;
    const d = groups[7] & 0xff;
    return isBlockedV4(ipv4ToInt(a, b, c, d));
  }
  // fc00::/7 — unique local
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 — link-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  return false;
}

/**
 * True when `address` (a bare IP, as returned by dns.lookup) falls in
 * loopback, private, link-local/metadata, unspecified, or IPv6-equivalent
 * blocked ranges. Pure function — no DNS lookups here, the caller resolves
 * hostnames first and passes each resulting address through this check.
 */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4 !== null) return isBlockedV4(v4);

  const v6 = parseIpv6(address);
  if (v6 !== null) return isBlockedV6(v6);

  return false;
}

/** Hostname literals that must always be refused regardless of DNS resolution. */
export function isBlockedHostnameLiteral(hostname: string): boolean {
  return hostname.toLowerCase() === "localhost";
}
