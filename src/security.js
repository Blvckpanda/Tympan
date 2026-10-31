/**
 * security.js — secure-by-default request policy (spec §1 wedge #2, §6).
 *
 * Untrusted HTML is safe by default:
 *   - the top-level source document is loaded from file://; every OTHER
 *     file:// request (iframes, images, XHR from the page) is blocked, so
 *     a converted document cannot read local files
 *   - requests to private and link-local networks are blocked (SSRF guard),
 *     including the cloud-metadata endpoints (169.254.169.254,
 *     fd00:ec2::254) — the classic server-side escape hatches
 *   - `--offline` / options.offline blocks ALL network requests
 *   - `--allow-net host` / options.allowNet overrides the private-range
 *     blocklist for named hosts (allowlist wins; `*` allows everything)
 *
 * 2026-10 rebuild: the decision is made on ADDRESS, not on the name as
 * written. Hostnames are resolved (`resolve-and-pin`) and any resolved
 * address inside a private range blocks the request; IPv4 and IPv6 literals
 * are parsed the way a resolver parses them (decimal/hex numeric forms,
 * hex-mapped and dotted-mapped IPv6) before the blocklist judges them; and
 * trailing-dot / bracketed / zone-id host spellings are normalized first.
 * Every block is counted and reported via onProgress('blocked', ...) —
 * a blocked request never silently changes the output.
 */
import net from 'node:net';
import dns from 'node:dns';

/** Names that always loop back, and suffixes that only resolve privately. */
const LOOPBACK_HOSTS = new Set(['localhost', 'localhost.localdomain']);
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** One net.BlockList over every range the manual octal math used to cover. */
let BLOCKLIST = null;
function blocklist() {
  if (!BLOCKLIST) {
    BLOCKLIST = new net.BlockList();
    const ranges = [
      ['0.0.0.0', 8],    // this-network
      ['10.0.0.0', 8],   // RFC1918 private
      ['100.64.0.0', 10],// CGNAT
      ['127.0.0.0', 8],  // v4 loopback
      ['169.254.0.0', 16],// link-local incl. cloud metadata
      ['172.16.0.0', 12],// RFC1918 private
      ['192.168.0.0', 16],// RFC1918 private
    ];
    for (const [net1, prefix] of ranges) BLOCKLIST.addSubnet(net1, prefix);
    // v6 membership is judged on the parsed group value (see
    // V6_PRIVATE_PREFIXES): this runtime's blocklist.check needs an explicit
    // type argument for v6, so the ranges live in their own table.
  }
  return BLOCKLIST;
}

/**
 * Canonical host for a decision: lowercase, unbracketed, zone-less,
 * trailing dots stripped. `localhost` and `localhost.` are one name.
 * @param {string} host
 * @returns {string}
 */
export function normalizeHost(host) {
  let h = String(host || '').toLowerCase().trim();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const pct = h.indexOf('%');
  if (pct !== -1) h = h.slice(0, pct);
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** One dotted part, parsed the way a resolver parses a URL host (octal on a leading 0). */
function partNum(part) {
  if (/^0x[0-9a-f]+$/.test(part)) return parseInt(part, 16);
  if (/^0[0-9]+$/.test(part)) return parseInt(part, 8);
  if (/^\d+$/.test(part)) return parseInt(part, 10);
  return NaN;
}

/**
 * A 4-part dotted or single-number IPv4 LITERAL (decimal or hex), normalized
 * to a dotted quad, or null. `2130706415` and `0x7f000001` are 127.0.0.1;
 * a leading-zero dotted part is OCTAL, exactly how a resolver parses a URL
 * host (`0177.0.0.1` = 127.0.0.1). 2/3-part forms are NOT recognized here
 * on purpose: they fall to the resolver, whose getaddrinfo answer is an
 * address this file then judges.
 * @param {string} host
 * @returns {string|null} canonical dotted quad
 */
export function parseIPv4Literal(host) {
  const h = normalizeHost(host);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const vals = h.split('.').map(partNum);
    if (vals.some((v) => !Number.isFinite(v) || v > 255)) return null;
    return vals.join('.');
  }
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h)) {
    const n = parseInt(h, h.startsWith('0x') ? 16 : 10);
    if (!Number.isFinite(n) || n < 0 || n > 4294967295) return null;
    return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
  }
  return null;
}

/** Groups of `::a:b:c:...` (with `::` compression and an embedded v4 tail). */
function parseIPv6Groups(host) {
  let h = normalizeHost(host);
  if (!h || net.isIP(h) !== 6) return null;
  if (h.includes('.')) { // embedded v4: `::ffff:127.0.0.1` -> `::ffff:7f00:1`
    const idx = h.lastIndexOf(':');
    const v4 = parseIPv4Literal(h.slice(idx + 1));
    if (!v4) return null;
    const o = v4.split('.').map((n) => Number(n));
    h = h.slice(0, idx + 1) + (o[0] << 8 | o[1]).toString(16) + ':' + (o[2] << 8 | o[3]).toString(16);
  }
  const compressed = h.includes('::');
  const halves = compressed ? h.split('::') : [h, null];
  if (!compressed && halves[0].split(':').length !== 8) return null;
  const head = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const tail = compressed && halves[1] ? halves[1].split(':').filter(Boolean) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < (compressed ? 1 : 0)) return null;
  const groups = [];
  for (const part of [...head, ...Array(missing).fill('0'), ...tail]) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

/** If `groups` is IPv4-mapped (::ffff:0:0/96), the embedded dotted quad. */
function mappedV4(groups) {
  if (!groups || groups.slice(0, 5).some((g) => g !== 0) || groups[5] !== 0xffff) return null;
  return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
}

/**
 * Is an ADDRESS private/metadata? Accepts any literal spelling a URL may
 * carry (dotted, numeric, hex, bracketed, mapped v6) and any resolved
 * address dns.lookup returns. Unparsable-but-ip-shaped input fails CLOSED.
 * @param {string} addr
 * @returns {boolean}
 */
export function isPrivateAddress(addr) {
  if (!addr) return false;
  const v4 = parseIPv4Literal(String(addr).replace(/^\[|\]$/g, ''));
  if (v4) return blocklist().check(v4);
  const bare = String(addr).replace(/^\[|\]$/g, '');
  if (net.isIP(bare) === 6) {
    const groups = parseIPv6Groups(bare);
    if (!groups) return true; // claimed v6 we could not parse: fail closed
    const mapped = mappedV4(groups);
    if (mapped) return blocklist().check(mapped);
    let value = BigInt(0);
    for (const g of groups) value = (value << BigInt(16)) | BigInt(g);
    for (const [network, bits] of V6_PRIVATE_PREFIXES) {
      const mask = ~((BigInt(1) << BigInt(128 - bits)) - BigInt(1));
      if ((value & mask) === (BigInt(network) & mask)) return true;
    }
    return false;
  }
  return false;
}

/**
 * Is `host` a private/metadata NAME or ADDRESS literal? Name-level checks
 * stay cheap and DNS-free; address literals are judged on the blocklist.
 * @param {string} host
 * @returns {boolean}
 */
export function isPrivateTarget(host) {
  const h = normalizeHost(host);
  if (!h) return false;
  if (LOOPBACK_HOSTS.has(h)) return true;
  if (PRIVATE_SUFFIXES.some((s) => h.endsWith(s))) return true;
  return isPrivateAddress(h);
}

/**
 * v6 private ranges need no blocklist: membership is judged on the parsed
 * 128-bit group value instead (this runtime's blocklist.check requires an
 * explicit `type` argument that a bare-string call does not pass).
 * @type {Array<[bigint, number]>} network value, prefix bits
 */const V6_PRIVATE_PREFIXES = [
  [0x0n, 128],             // unspecified ::
  [0x1n, 128],             // loopback ::1
  [0xfc00n << 112n, 7],    // ULA (covers the fd00:ec2::254 metadata endpoint)
  [0xfe80n << 112n, 10],   // v6 link-local
];

/** Resolution is expensive; one lookup per host per TTL, then pinned. */
const RESOLVE_TTL = 60_000;

/**
 * The gate's address-level decision for a normalized host (allowlist and
 * file:// rules already handled by the caller). Returns a block reason or
 * null — never throws; an unresolvable host blocks fail-closed.
 * @param {string} host normalized
 * @param {{resolver?: (host: string) => Promise<Array<{address: string}>>, cache?: Map<string, {at: number, reason: string|null}>}} policy
 * @returns {Promise<string|null>}
 */
async function addressViolation(host, policy) {
  // A literal needs no DNS: judge the address exactly as parsed.
  if (parseIPv4Literal(host)) {
    return isPrivateAddress(host) ? 'private/metadata network' : null;
  }
  // A loopback/suffix NAME blocks without resolution (an attacker's
  // authoritative zone for `localhost.` must not downgrade the name check).
  if (isPrivateTarget(host)) return 'private/metadata network';

  // Name path: resolve-and-pin. ANY resolved address inside a private
  // range blocks, whether or not other results are public.
  const cache = policy.cache || (policy.cache = new Map());
  const hit = cache.get(host);
  const now = Date.now();
  if (hit && now - hit.at < RESOLVE_TTL) return hit.reason;
  const resolver = policy.resolver || ((h, opts) => dns.promises.lookup(h, opts));
  let addrs;
  try {
    addrs = await resolver(host, { all: true, verbatim: true });
    if (!Array.isArray(addrs)) addrs = [{ address: String(addrs) }];
  } catch {
    const reason = 'dns-unresolved';
    cache.set(host, { at: now, reason });
    return reason;
  }
  const reason = addrs.some((r) => r && isPrivateAddress(r.address))
    ? 'private/metadata network (resolved)'
    : null;
  cache.set(host, { at: now, reason });
  return reason;
}

/**
 * The blocking Playwright route handler (bind with .bind(null, policy)).
 * The source document itself is exempted: it is loaded as file:// and IS
 * the thing the user asked us to convert.
 * @param {{offline: boolean, allowed: Set<string>, mainUrl: string,
 *           resolver?: Function, cache?: Map}} policy
 * @param {import('playwright').Route} route
 */
export async function requestGate(policy, route) {
  const req = route.request();
  const url = new URL(req.url());
  const host = normalizeHost(url.hostname);

  // The top-level document itself: always allowed.
  if (req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame() && req.url() === policy.mainUrl) {
    return route.continue();
  }

  let blocked = null;
  if (policy.offline && url.protocol !== 'file:') {
    blocked = 'offline mode';
  } else if (policy.allowed.has('*') || policy.allowed.has(host)) {
    // explicit allowlist wins over every blocklist
  } else if (url.protocol === 'file:') {
    blocked = 'file:// read';
  } else {
    blocked = await addressViolation(host, policy);
  }
  if (blocked) {
    route.abort('blockedbyclient');
    return blocked;
  }
  await route.continue();
  return null;
}

/**
 * Build the request policy and arm it on a page.
 * @param {import('playwright').Page} page
 * @param {object} [opts] { offline, allowNet, mainUrl, onProgress, resolver }
 * @returns {{arm(): Promise<void>, unarm(): Promise<void>, blocked(): number}}
 */
export function armRequestPolicy(page, opts = {}) {
  const policy = {
    offline: !!opts.offline,
    allowed: new Set((opts.allowNet || []).map((h) => h.toLowerCase().trim()).map(normalizeHost).filter(Boolean)),
    mainUrl: opts.mainUrl || null,
  };
  let count = 0;
  const handler = requestGate.bind(null, policy);
  return {
    async arm() {
      await page.route('**/*', async (route) => {
        const blocked = await handler(route);
        if (blocked) {
          count++;
          if (opts.onProgress) opts.onProgress('blocked', { url: route.request().url(), reason: blocked });
        }
      });
    },
    async unarm() {
      await page.unroute('**/*');
    },
    blocked: () => count,
  };
}
