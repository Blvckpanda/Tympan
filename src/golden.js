/**
 * golden.js — `tympan test`: pixel-golden regression for rendered output.
 *
 * Rendering is the one failure mode text extraction cannot see: a dropped
 * background, a collapsed grid, a page that lost its figure. This module
 * answers "do the pages still LOOK the same?" by turning every rendered PDF
 * page into a small RGB fingerprint and comparing it with a recorded baseline
 * (`.tympan/golden/<input>/pNNN.png` — a viewable thumbnail, not a blob).
 *
 * Fingerprints rather than raw pixels, deliberately:
 *   - downscaling to a 96px-wide grid absorbs the font-rasterizer differences
 *     between machines, while a real layout change (moved block, lost
 *     background, dropped page) still moves cells;
 *   - a per-cell threshold ignores antialiasing noise, and a tolerance on the
 *     share of differing cells gives one knob with an honest meaning.
 *
 * Rasterization runs pdfjs (already a dependency) inside Chromium over the
 * exact bytes Chromium printed — no new package, no extra binary. Baselines
 * are decoded at their own size and compared against the grid size, so a
 * geometry change is reported instead of silently squashed to fit.
 *
 * The comparison maths is pure and tested without a browser; the in-page
 * functions carry no Node scope (they are serialized into the page).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { convertMany, makeWorkdir } from './pipeline.js';
import { launchOptions } from './browser.js';

/** Fingerprint grid width in cells (height follows the page aspect). */
export const FINGERPRINT_WIDTH = 96;
/** A cell counts as different above this per-channel delta (0-255). */
export const CELL_THRESHOLD = 24;
/** Default share of differing cells still accepted as "the same page". */
export const DEFAULT_TOLERANCE = 0.02;
/** Render scale relative to the grid — averaged down for a stable fingerprint. */
export const SUPERSAMPLE = 4;

/**
 * Fingerprint grid for a page of `w`x`h` — aspect preserved.
 * @returns {{w: number, h: number}}
 */
export function fingerprintSize(w, h, width = FINGERPRINT_WIDTH) {
  const safeW = Number(w) > 0 ? Number(w) : width;
  const safeH = Number(h) > 0 ? Number(h) : width;
  return { w: width, h: Math.max(1, Math.round((width * safeH) / safeW)) };
}

/**
 * Compare two RGB fingerprints (flat arrays, `channels` bytes per cell).
 * Pure: no browser, no I/O, so the whole contract is unit-tested hermetically.
 * @param {ArrayLike<number>} a rendered fingerprint
 * @param {ArrayLike<number>} b recorded fingerprint
 * @param {object} [options] { tolerance, cellThreshold, channels }
 * @returns {{ok: boolean, reason: string|null, cells: number, differing: number,
 *   diffRatio: number, meanDelta: number, maxDelta: number}}
 */
export function compareFingerprints(a, b, options = {}) {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const cellThreshold = options.cellThreshold ?? CELL_THRESHOLD;
  const channels = options.channels ?? 3;
  const unusable = (reason, cells) => ({
    ok: false,
    reason,
    cells,
    differing: cells,
    diffRatio: 1,
    meanDelta: 255,
    maxDelta: 255,
  });
  if (!a || !b) return unusable(a || b ? 'missing fingerprint' : 'no fingerprint at all', 0);
  if (a.length !== b.length) return unusable('size mismatch', Math.max(a.length, b.length) / channels);
  if (a.length % channels !== 0) return unusable('malformed fingerprint', Math.floor(a.length / channels));
  const cells = a.length / channels;
  let sum = 0;
  let max = 0;
  let over = 0;
  for (let c = 0; c < cells; c++) {
    const base = c * channels;
    let cellMax = 0;
    for (let k = 0; k < channels; k++) {
      const delta = Math.abs(a[base + k] - b[base + k]);
      sum += delta;
      if (delta > cellMax) cellMax = delta;
    }
    if (cellMax > max) max = cellMax;
    if (cellMax > cellThreshold) over++;
  }
  const diffRatio = cells ? over / cells : 0;
  return {
    ok: diffRatio <= tolerance,
    reason: null,
    cells,
    differing: over,
    diffRatio,
    meanDelta: cells ? sum / (cells * channels) : 0,
    maxDelta: max,
  };
}

/** Stable per-input directory name for its baselines. */
export function goldenSlug(input) {
  const stem = (path.basename(String(input)).replace(/\.html?$/i, '') || 'input').replace(/[^\w.-]+/g, '-');
  const hash = crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 8);
  return `${stem}-${hash}`;
}

/** Baseline file name for page `n` (1-based). */
export function goldenPageName(n) {
  return `p${String(n).padStart(3, '0')}.png`;
}

/** Locate pdfjs-dist's build inside the nearest node_modules (discovery, as browser.js does). */
function pdfjsFiles() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const lib = path.join(dir, 'node_modules', 'pdfjs-dist', 'build', 'pdf.min.js');
    const worker = path.join(dir, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.js');
    if (fs.existsSync(lib) && fs.existsSync(worker)) return { lib, worker };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('pdfjs-dist not found — run npm install (required by `tympan test`)');
}

/**
 * A Chromium page with pdfjs loaded. The worker bundle is injected as a plain
 * script (not as a Worker URL), which keeps pdfjs on its in-page fake-worker
 * path: rasterization needs no HTTP server, no port and no cleanup.
 */
async function rasterHarness(browser) {
  const files = pdfjsFiles();
  const page = await browser.newPage({ viewport: { width: 1200, height: 1600 } });
  await page.setContent('<!doctype html><meta charset="utf-8"><body>tympan raster harness</body>');
  await page.addScriptTag({ content: fs.readFileSync(files.lib, 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync(files.worker, 'utf8') });
  return page;
}

/* ------------------------------------------------------------------ *
 * In-page functions — pdfjs is a harness global, everything else arrives
 * as one argument (Playwright evaluate takes exactly one).
 * ------------------------------------------------------------------ */

/**
 * @param {{pdfBase64?: string, images?: string[], width: number, supersample: number}} arg
 * @returns {Promise<Array<{n: number, w: number, h: number, rgb: number[],
 *   png?: string, error?: string}>>}
 */
async function fingerprintInPage(arg) {
  const { pdfBase64, images, width, supersample } = arg;

  const hatch = (source, size, withPng) => {
    const small = document.createElement('canvas');
    small.width = size.w;
    small.height = size.h;
    const ctx = small.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, size.w, size.h);
    const data = ctx.getImageData(0, 0, size.w, size.h).data;
    const rgb = new Array(size.w * size.h * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }
    const out = { w: size.w, h: size.h, rgb };
    if (withPng) out.png = small.toDataURL('image/png').split(',')[1];
    return out;
  };

  if (images) {
    const pages = [];
    for (let i = 0; i < images.length; i++) {
      const img = new Image();
      try {
        await new Promise((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('unreadable'));
          img.src = images[i];
        });
      } catch (e) {
        pages.push({ n: i + 1, w: 0, h: 0, rgb: null, error: 'baseline is not a readable PNG' });
        continue;
      }
      const size = { w: img.naturalWidth, h: img.naturalHeight };
      pages.push({ n: i + 1, ...hatch(img, size, false) });
    }
    return pages;
  }

  const raw = atob(pdfBase64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const pg = await doc.getPage(n);
    const nat = pg.getViewport({ scale: 1 });
    const viewport = pg.getViewport({ scale: (width * supersample) / nat.width });
    const big = document.createElement('canvas');
    big.width = Math.max(1, Math.round(viewport.width));
    big.height = Math.max(1, Math.round(viewport.height));
    const bctx = big.getContext('2d', { willReadFrequently: true });
    bctx.fillStyle = '#ffffff';
    bctx.fillRect(0, 0, big.width, big.height);
    await pg.render({ canvasContext: bctx, viewport }).promise;
    const size = { w: width, h: Math.max(1, Math.round((width * big.height) / big.width)) };
    pages.push({ n, ...hatch(big, size, true) });
  }
  return pages;
}

const b64 = (file) => fs.readFileSync(file).toString('base64');

/**
 * Compare (or record) one input's pages against its baselines.
 * @returns {Promise<{input: string, ok: boolean, error: string|null, stale: string[],
 *   pages: Array<object>}>}
 */
async function scorePages({ page, input, rendered, goldenDir, update, tolerance }) {
  const dir = path.join(goldenDir, goldenSlug(input));
  const files = rendered.map((p) => path.join(dir, goldenPageName(p.n)));
  const loadIdx = [];
  const dataUrls = [];
  files.forEach((file, i) => {
    if (fs.existsSync(file)) {
      loadIdx.push(i);
      dataUrls.push(`data:image/png;base64,${b64(file)}`);
    }
  });
  const decoded = dataUrls.length
    ? await page.evaluate(fingerprintInPage, { images: dataUrls, width: 0, supersample: 0 })
    : [];
  const baseline = new Map(loadIdx.map((i, k) => [i, decoded[k]]));

  if (update && rendered.length) fs.mkdirSync(dir, { recursive: true });

  const pages = [];
  let ok = true;
  for (let i = 0; i < rendered.length; i++) {
    const p = rendered[i];
    const file = files[i];
    const base = baseline.get(i);
    if (update) {
      if (!p.png) throw new Error(`internal: page ${p.n} produced no PNG for the baseline`);
      fs.writeFileSync(file, Buffer.from(p.png, 'base64'));
      pages.push({ page: p.n, ok: true, status: base ? 'updated' : 'created', file, grid: `${p.w}x${p.h}` });
      continue;
    }
    if (!base || !base.rgb) {
      ok = false;
      pages.push({
        page: p.n,
        ok: false,
        status: 'missing',
        file,
        grid: `${p.w}x${p.h}`,
        error: base ? base.error : 'no baseline recorded',
      });
      continue;
    }
    if (base.w !== p.w || base.h !== p.h) {
      ok = false;
      pages.push({
        page: p.n,
        ok: false,
        status: 'geometry-changed',
        file,
        grid: `${p.w}x${p.h}`,
        baseline: `${base.w}x${base.h}`,
        error: `page size changed (baseline ${base.w}x${base.h})`,
      });
      continue;
    }
    const cmp = compareFingerprints(p.rgb, base.rgb, { tolerance });
    if (!cmp.ok) ok = false;
    pages.push({
      page: p.n,
      ok: cmp.ok,
      status: cmp.ok ? 'match' : 'diff',
      file,
      grid: `${p.w}x${p.h}`,
      diffRatio: cmp.diffRatio,
      differing: cmp.differing,
      cells: cmp.cells,
      meanDelta: cmp.meanDelta,
      maxDelta: cmp.maxDelta,
    });
  }
  // Baselines for pages this render no longer has: a shrunken document must
  // not pass silently just because the missing pages were never compared.
  const stale = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => /^p\d+\.png$/.test(f) && !files.some((x) => path.basename(x) === f))
        .sort()
    : [];
  if (stale.length) ok = false;
  return { input, ok, error: null, stale, pages };
}

/**
 * Pixel-golden regression over a set of inputs.
 *
 * Each input is converted through tympan's own pipeline (one warm browser for
 * the whole set), every resulting page is fingerprinted, and each is compared
 * with its recorded baseline. `update` records or refreshes baselines instead
 * of comparing — that is how a deliberate change is accepted.
 *
 * @param {string[]} inputs file paths or URLs
 * @param {object} [options] convert() options, plus
 *   goldenDir?: string  baseline directory (default `.tympan/golden`)
 *   update?: boolean    record baselines instead of comparing
 *   tolerance?: number  share of differing cells allowed (default 0.02)
 *   keepDir?: string    keep the generated PDFs here (default: temp, deleted)
 *   browser?: object    reuse a warm browser (otherwise one is launched)
 * @returns {Promise<{ok: boolean, updated: boolean, tolerance: number,
 *   goldenDir: string, entries: Array<object>}>}
 */
export async function goldenTest(inputs, options = {}) {
  const list = (Array.isArray(inputs) ? inputs : [inputs]).filter(Boolean);
  if (list.length === 0) throw new Error('goldenTest: no inputs');
  const goldenDir = path.resolve(options.goldenDir || '.tympan/golden');
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const width = options.fingerprintWidth ?? FINGERPRINT_WIDTH;
  const update = !!options.update;
  const ownBrowser = !options.browser;
  const browser = options.browser || (await chromium.launch(launchOptions(options)));
  const workdir = options.keepDir ? null : makeWorkdir();
  const pdfDir = options.keepDir ? path.resolve(options.keepDir) : workdir;
  if (!workdir) fs.mkdirSync(pdfDir, { recursive: true });

  try {
    const batch = await convertMany(list, {
      ...options,
      browser,
      out: undefined,
      perInput: (input) => ({
        out: path.join(pdfDir, `${goldenSlug(input)}.pdf`),
        email: false,
        emailOut: undefined,
      }),
    });

    const harness = await rasterHarness(browser);
    try {
      const entries = [];
      for (const entry of batch.entries) {
        if (!entry.ok) {
          entries.push({ input: entry.input, ok: false, error: entry.error, stale: [], pages: [] });
          continue;
        }
        const rendered = await harness.evaluate(fingerprintInPage, {
          pdfBase64: b64(entry.result.master),
          width,
          supersample: SUPERSAMPLE,
        });
        entries.push(await scorePages({ page: harness, input: entry.input, rendered, goldenDir, update, tolerance }));
      }
      return {
        ok: entries.every((e) => e.ok),
        updated: update,
        tolerance,
        goldenDir,
        entries,
      };
    } finally {
      await harness.close();
    }
  } finally {
    if (ownBrowser) await browser.close();
    if (workdir) fs.rmSync(workdir, { recursive: true, force: true });
  }
}

/**
 * Human-readable golden report (one line per input, then per differing page).
 * Pure — the CLI prints it, tests assert on it.
 * @param {object} report goldenTest() result
 * @returns {string}
 */
export function formatGoldenReport(report) {
  const lines = [
    `tympan test: ${report.entries.length} input(s) against ${report.goldenDir}` +
      (report.updated ? ' (recording baselines)' : ` (tolerance ${(report.tolerance * 100).toFixed(1)}% of cells)`),
  ];
  for (const entry of report.entries) {
    const mark = entry.ok ? '[ok]' : '[FAIL]';
    lines.push(`${mark} ${entry.input}` + (entry.error && entry.pages.length === 0 ? ` — ${entry.error}` : ''));
    for (const p of entry.pages) {
      if (p.status === 'match' && !report.updated) {
        lines.push(`     page ${p.page}: ${p.grid}, matches (${(p.diffRatio * 100).toFixed(2)}% of cells differ)`);
      } else if (p.status === 'diff') {
        lines.push(
          `     page ${p.page}: DIFFERS — ${(p.diffRatio * 100).toFixed(2)}% of cells (max delta ${p.maxDelta}), baseline ${p.file}`
        );
      } else if (p.status === 'missing' || p.status === 'geometry-changed') {
        lines.push(`     page ${p.page}: ${p.error} — baseline ${p.file}`);
      } else {
        lines.push(`     page ${p.page}: ${p.status} (${p.grid}) ${p.file}`);
      }
    }
    for (const s of entry.stale || []) lines.push(`     stale baseline (no such page any more): ${s}`);
  }
  const failed = report.entries.filter((e) => !e.ok).length;
  lines.push(
    report.ok
      ? report.updated
        ? 'tympan test: baselines recorded'
        : 'tympan test: no visual change'
      : `tympan test: ${failed} input(s) differ — review the diff, then re-record with --update if it is intended`
  );
  return lines.join('\n');
}
