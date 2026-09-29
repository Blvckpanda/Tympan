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
 * Every block is counted and reported via onProgress('blocked', ...) —
 * a blocked request never silently changes the output.
 */

/** Hosts that always resolve inside the machine or a private network. */
const LOOPBACK_HOSTS = new Set(['localhost', 'localhost.localdomain']);

/**
 * Is `host` (already lowercased) a private/metadata name or address?
 * Covers IPv4 loopback/private/link-local/CGNAT ranges, IPv6 loopback,
 * ULA (fc00::/7) and link-local (fe80::/10), IPv4-mapped IPv6, and the
 * EC2/IMDS metadata endpoints.
 * @param {string} host
 * @returns {boolean}
 */
export function isPrivateTarget(host) {
  if (!host) return false;
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(h)) return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return false; // not an IPv4 literal; let DNS decide
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // IPv6 (browsers bracket literals; Playwright hands us the bare address)
  if (h.includes(':')) {
    const addr = h;
    if (addr === '::' || addr === '::1') return true;
    if (/^f[cd]/.test(addr)) return true; // fc00::/7 ULA
    if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
    // IPv4-mapped (::ffff:a.b.c.d) — evaluate the embedded v4
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
    if (mapped) return isPrivateTarget(mapped[1]);
    // IMDSv6 endpoint used by cloud metadata services
    if (addr === 'fd00:ec2::254') return true;
    return false;
  }
  return false;
}

/**
 * The blocking Playwright route handler (bind with .bind(null, policy)).
 * The source document itself is exempted: it is loaded as file:// and IS
 * the thing the user asked us to convert.
 * @param {{offline: boolean, allowed: Set<string>, mainUrl: string}} policy
 * @param {import('playwright').Route} route
 */
export async function requestGate(policy, route) {
  const req = route.request();
  const url = new URL(req.url());
  const host = (url.hostname || '').toLowerCase();

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
  } else if (isPrivateTarget(host)) {
    blocked = 'private/metadata network';
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
 * @param {object} [opts] { offline, allowNet, mainUrl, onProgress }
 * @returns {{arm(): Promise<void>, unarm(): Promise<void>, blocked(): number}}
 */
export function armRequestPolicy(page, opts = {}) {
  const policy = {
    offline: !!opts.offline,
    allowed: new Set((opts.allowNet || []).map((h) => String(h).toLowerCase().trim()).filter(Boolean)),
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
