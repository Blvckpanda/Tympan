/**
 * assets.js — local sibling images survive the request gate.
 *
 * Measured finding (plan v0.8, W1): `<img src="logo.png">` beside a local page
 * is refused by tympan's own request gate (`file://` reads are blocked by
 * design — that gate is the product's safety guarantee), so the image prints
 * as blank space and `tympan lint` reports `broken-asset` for a file the user
 * can see sitting on disk. The fix does NOT weaken the gate: Node reads the
 * file (the process already reads the user's local HTML) and hands the page a
 * data URI, so the printed document is complete and no request is unblocked.
 *
 * Bounds (all deterministic, all local-only):
 *   - only `file:` URLs on images that actually failed;
 *   - only image extensions we can name as MIME types (an `.html` or `.exe`
 *     sibling is never repackaged as a data URL);
 *   - only files that exist and are under the size cap (refusing a 4 GB
 *     asset beats partially loading it).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

/** DOM side: local image URLs that exist in the page but failed to load. */
export function collectLocalBrokenImagesInPage() {
  const out = [];
  for (const img of document.images) {
    if (!img.complete || img.naturalWidth !== 0) continue;
    const src = img.currentSrc || img.src || '';
    if (/^file:/i.test(src)) out.push(src);
  }
  return out;
}

/** DOM side: swap failed local sources for data URIs the page can paint. */
export function inlineLocalImagesInPage(map) {
  let inlined = 0;
  for (const img of document.images) {
    const cur = img.currentSrc || img.src || '';
    if (map[cur]) {
      // srcset/sizes would re-select the failed candidate on the next sizing
      // pass; a data URI has exactly one variant.
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      img.src = map[cur];
      inlined++;
    }
  }
  return inlined;
}

/**
 * Node side: turn the page's list of failing `file:` URLs into data URIs.
 * @param {string[]} urls file:// URLs reported by collectLocalBrokenImagesInPage
 * @param {{maxBytes?: number, exists?: (p: string) => boolean, read?: (p: string) => Buffer}} [io]
 *   injectable for tests; defaults touch the real filesystem.
 * @returns {{map: Record<string,string>, inlined: string[], skipped: Array<{url: string, reason: string}>}}
 */
export function resolveLocalAssets(urls, io = {}) {
  const exists = io.exists || fs.existsSync;
  const read = io.read || ((p) => fs.readFileSync(p));
  const maxBytes = io.maxBytes ?? MAX_ASSET_BYTES;
  const map = {};
  const inlined = [];
  const skipped = [];
  for (const sourceUrl of urls) {
    let p;
    try {
      p = fileURLToPath(sourceUrl);
    } catch {
      skipped.push({ url: sourceUrl, reason: 'not a file URL' });
      continue;
    }
    let stat = null;
    try {
      stat = io.stat ? io.stat(p) : fs.statSync(p);
    } catch {
      /* missing handled below */
    }
    if (!stat) {
      skipped.push({ url: sourceUrl, reason: 'file does not exist' });
      continue;
    }
    if (!stat.isFile || !stat.isFile()) {
      skipped.push({ url: sourceUrl, reason: 'not a regular file' });
      continue;
    }
    if (stat.size > maxBytes) {
      skipped.push({ url: sourceUrl, reason: `file is larger than ${maxBytes} bytes` });
      continue;
    }
    const ext = path.extname(p).replace('.', '').toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      skipped.push({ url: sourceUrl, reason: `.${ext} is not a known image type` });
      continue;
    }
    map[sourceUrl] = `data:${mime};base64,${read(p).toString('base64')}`;
    inlined.push(sourceUrl);
  }
  return { map, inlined: inlined.map((u) => map[u] && u).filter(Boolean), skipped };
}

/**
 * Orchestrate one inline round against an already-loaded page.
 * @param {import('playwright').Page} page the source page (fonts/images settled)
 * @returns {Promise<{inlined: number, urls: string[], bytes: number, skipped: object[]}>}
 */
export async function inlineLocalAssets(page) {
  const urls = await page.evaluate(collectLocalBrokenImagesInPage);
  if (!urls.length) return { inlined: 0, urls: [], bytes: 0, skipped: [] };
  const { map, inlined, skipped } = resolveLocalAssets(urls);
  if (!inlined.length) return { inlined: 0, urls, bytes: 0, skipped };
  const bytes = inlined.reduce((a, u) => a + Buffer.from(map[u], 'base64').length, 0);
  const count = await page.evaluate(inlineLocalImagesInPage, map);
  return { inlined: count, urls, bytes, skipped };
}
