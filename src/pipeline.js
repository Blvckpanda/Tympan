/**
 * pipeline.js — the core conversion engine.
 *
 * Proven sequence (hard-won on a 24-section investment deck):
 *   1. Load the source HTML at its own content width; wait for fonts +
 *      every image; measure its page background and content width.
 *   2. Detect sections (detect.js), capture the pre-first-section prelude
 *      (hero/cover) and build the clean-document template (template.js).
 *   3. Print each section from a fresh clean document onto exactly one page
 *      with shrink-to-fit scale (the closed loop that beat late webfonts).
 *   4. Merge pages centered onto the final geometry via pdf-lib (vector
 *      rescale — text stays selectable), painting each final page with the
 *      source's own background first so margins match the document.
 *   5. Verify: page count === section count, zero spill pages, optional
 *      text probe on the last page.
 *
 * Determinism (v0.5): every output carries fixed timestamps, a
 * content-derived /ID and a `tympan:<hash>` keyword over the source bytes
 * plus output-affecting options — identical input produces byte-identical
 * output under the pinned engine.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';
import { launchOptions } from './browser.js';
import {
  buildCleanTemplate,
  measurePageBackgroundAndWidth,
  clampLoadWidth,
  CONTENT_W,
  PORTRAIT_CONTENT_W,
  DEFAULT_CONTENT_MAX_WIDTH,
} from './template.js';
import { detectSectionsInPage, capturePreludeInPage, withPrelude } from './detect.js';
import { verifyOutputs } from './verify.js';
import { downscaleImagesInPage, mergeFooter } from './email.js';
import { armRequestPolicy } from './security.js';

const require = createRequire(import.meta.url);
const { version: TYMPAN_VERSION } = require('../package.json');

/** Final page geometry in pt (PDF points, 72/inch) — landscape values. */
export const PAGE_GEOMETRY = {
  a4: { W: 841.89, H: 595.28 },
  letter: { W: 792, H: 612 },
};

/** Default page margins in inches (matches the proven deck layout). */
export const DEFAULT_MARGINS = { top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 };

/** Fixed metadata epoch: every output carries the same timestamps. */
const FIXED_DATE = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

/** Producer string written into every PDF trailer. */
const PRODUCER = `tympan ${TYMPAN_VERSION}`;

/** Temp workspace for per-section PDFs (caller cleans up). */
export function makeWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-'));
}

/**
 * Load the source HTML and extract, in one visit: the clean-document
 * template (carrying the source's own background), detected sections
 * (HTML + ids), the pre-first-section prelude (hero/cover) and the footer
 * band (a trailing centered block merged into the last section).
 */
export async function loadAndExtract(browser, inputPath, selector, opts = {}) {
  const loadW = opts.loadW || clampLoadWidth(CONTENT_W);
  const page = await browser.newPage({
    viewport: { width: loadW, height: 1200 },
  });
  const url = pathToFileURL(inputPath).href;
  const gate = armRequestPolicy(page, {
    offline: opts.offline,
    allowNet: opts.allowNet,
    mainUrl: url,
    onProgress: opts.onProgress,
  });
  await gate.arm();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForFunction(
    // `complete` is true for settled images whether they loaded OR failed
    // (blocked file:// or offline requests must not hang the wait).
    () => Array.from(document.images).every((i) => i.complete),
    null,
    { timeout: 60000 }
  );
  const measured = await page.evaluate(measurePageBackgroundAndWidth, DEFAULT_CONTENT_MAX_WIDTH);
  const background = opts.background || measured.background;
  const contentMaxWidth = opts.contentMaxWidth ?? clampLoadWidth(measured.contentWidth);
  // Playwright evaluate takes exactly ONE serializable arg — bundle them.
  const templateHtml = await page.evaluate(buildCleanTemplate, { maxWidthPx: contentMaxWidth, background });
  const detection = await page.evaluate(detectSectionsInPage, selector);
  const prelude = await page.evaluate(capturePreludeInPage);
  const docTitle = await page.evaluate(() => (document.title || '').trim() || null);
  const footerHtml = await page.evaluate(() => {
    // Trailing band that becomes part of the last page. Ordered: deck-style
    // centered block, semantic <footer>, landing-style trailing .footer div
    // (body-level — the real brief that exposed this used exactly that).
    const band =
      document.querySelector('main > div.text-center') ||
      document.querySelector('footer') ||
      document.querySelector('body > .footer');
    return band ? band.outerHTML : null;
  });
  await page.close();
  return { templateHtml, detection, prelude, footerHtml, background, contentMaxWidth, docTitle, blocked: gate.blocked() };
}

/**
 * Print one section's HTML from a fresh clean document onto ONE page,
 * shrinking just enough when the section is taller than the page.
 * Returns the section's CSS height in px (pre-scale).
 */
export async function printSection(browser, templateHtml, sectionHtml, outPath, geo, opts = {}) {
  const docHtml = templateHtml.replace('<main></main>', '<main>' + sectionHtml + '</main>');
  const page = await browser.newPage({ viewport: { width: geo.contentW, height: 1000 } });
  const gate = armRequestPolicy(page, {
    offline: opts.offline,
    allowNet: opts.allowNet,
    onProgress: opts.onProgress,
  });
  await gate.arm();
  try {
    await page.setContent(docHtml, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete), null, { timeout: 30000 }).catch(() => {});
    const { h, w } = await page.evaluate(() => {
      const el = document.querySelector('main');
      const r = el ? el.getBoundingClientRect() : { height: 400, width: 800 };
      // scrollWidth catches content that overflows the column (wide images,
      // pre, wide tables) — printing that would clip the right edge.
      const sw = Math.max(
        document.documentElement.scrollWidth,
        document.body ? document.body.scrollWidth : 0,
        r.width
      );
      return { h: r.height, w: sw };
    });
    const usableH = geo.H_IN - geo.margins.top - geo.margins.bottom;
    const usableW = geo.W_IN - geo.margins.left - geo.margins.right;
    // Open-loop measurement cannot be fully trusted: late font swaps make the
    // real print layout taller than measured, and Chromium's print rounding
    // spills sub-pixel remainders onto a second page when the scale lands
    // exactly on the boundary (both observed on tall text documents,
    // 2026-09-29). So the loop is closed: print, count the pages actually
    // produced, and shrink 10% per retry until the section holds its page.
    // The initial scale must also fit the WIDTH: the section is one page,
    // not a clipped strip (portrait columns wider than the text area were
    // silently right-clipped before v0.5).
    const hIn = h / 96;
    const wIn = w / 96;
    const heightBound = hIn > usableH;
    let scale = Math.min(1, usableH / hIn, usableW / wIn) * (heightBound ? 0.985 : 1);
    const pdfOpts = {
      path: outPath,
      printBackground: true,
      preferCSSPageSize: false,
      width: geo.W_IN + 'in',
      height: geo.H_IN + 'in',
      margin: {
        top: geo.margins.top + 'in',
        bottom: geo.margins.bottom + 'in',
        left: geo.margins.left + 'in',
        right: geo.margins.right + 'in',
      },
      displayHeaderFooter: false,
    };
    for (let attempt = 0; attempt < 6; attempt++) {
      await page.pdf({ ...pdfOpts, scale });
      const doc = await PDFDocument.load(fs.readFileSync(outPath));
      if (doc.getPageCount() === 1) break;
      scale *= 0.9;
    }
    return h;
  } finally {
    await page.close();
  }
}

/**
 * Print every section to its own one-page PDF; returns per-section info.
 */
export async function runPass(browser, templateHtml, sections, geo, workdir, onProgress, opts = {}) {
  const files = [];
  const perSection = [];
  for (let i = 0; i < sections.length; i++) {
    const f = path.join(workdir, `pg-${i}.pdf`);
    const h = await printSection(browser, templateHtml, sections[i].html, f, geo, opts);
    const doc = await PDFDocument.load(fs.readFileSync(f));
    const pages = doc.getPageCount();
    perSection.push({ id: sections[i].id, pages, heightPx: Math.round(h) });
    files.push(f);
    if (onProgress) onProgress('section', { index: i + 1, total: sections.length, id: sections[i].id, pages });
  }
  return { files, perSection };
}

/**
 * Write a PDF outline (bookmarks panel) with one entry per page, using
 * low-level pdf-lib objects (pdf-lib 1.x has no high-level outline API).
 * Each entry targets the top of its page with /Fit destination.
 * @param {import('pdf-lib').PDFDocument} doc
 * @param {import('pdf-lib').PDFPage[]} pages
 * @param {Array<{title: string}>} entries
 */
function writeOutline(doc, pages, entries) {
  const ctx = doc.context;
  const outlinesRef = ctx.nextRef();
  const pageRefs = pages.map((p) => p.ref);
  const itemRefs = entries.map(() => ctx.nextRef());
  entries.forEach((entry, i) => {
    const item = {
      Title: PDFHexString.fromText(entry.title),
      Parent: outlinesRef,
      Count: 0,
      Dest: [pageRefs[Math.min(i, pageRefs.length - 1)], 'Fit'],
    };
    if (i > 0) item.Prev = itemRefs[i - 1];
    if (i < entries.length - 1) item.Next = itemRefs[i + 1];
    ctx.assign(itemRefs[i], ctx.obj(item));
  });
  ctx.assign(
    outlinesRef,
    ctx.obj({
      Type: 'Outlines',
      First: itemRefs[0],
      Last: itemRefs[itemRefs.length - 1],
      Count: entries.length,
    })
  );
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

/**
 * Parse a CSS color to {r,g,b} in 0..1 for PDF painting. Supports #rgb,
 * #rrggbb, rgb()/rgba() (numeric or percent channels) and a small keyword
 * table. Fully transparent or unparsable -> null (caller keeps white).
 * @param {string} css
 * @returns {{r:number,g:number,b:number}|null}
 */
export function cssColorToRgb(css) {
  if (!css) return null;
  const s = String(css).trim().toLowerCase();
  const clamp3 = ({ r, g, b }) => ({
    r: Math.min(1, Math.max(0, r)),
    g: Math.min(1, Math.max(0, g)),
    b: Math.min(1, Math.max(0, b)),
  });
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    const h = hex[1];
    const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return clamp3({
      r: parseInt(f.slice(0, 2), 16) / 255,
      g: parseInt(f.slice(2, 4), 16) / 255,
      b: parseInt(f.slice(4, 6), 16) / 255,
    });
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(s);
  if (fn) {
    const parts = fn[1].split(/[,\s/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const ch = (v) => (v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v) / 255);
      const rgbv = { r: ch(parts[0]), g: ch(parts[1]), b: ch(parts[2]) };
      if ([rgbv.r, rgbv.g, rgbv.b].every(Number.isFinite)) {
        if (parts[3] !== undefined && parseFloat(parts[3]) === 0) return null;
        return clamp3(rgbv);
      }
    }
  }
  const NAMED = {
    white: '#ffffff', black: '#000000', silver: '#c0c0c0', gray: '#808080',
    grey: '#808080', navy: '#000080', blue: '#0000ff', teal: '#008080',
    aqua: '#00ffff', green: '#008000', lime: '#00ff00', olive: '#808000',
    yellow: '#ffff00', orange: '#ffa500', red: '#ff0000', maroon: '#800000',
    fuchsia: '#ff00ff', purple: '#800080', ivory: '#fffff0', beige: '#f5f5dc',
    snow: '#fffafa', ghostwhite: '#f8f8ff',
  };
  if (NAMED[s]) return cssColorToRgb(NAMED[s]);
  return null;
}

/**
 * Content stream that paints the full page rect with one color. Rounded to
 * 3 decimal places so identical input always serializes identically.
 */
function buildBackgroundStream(w, h, c) {
  const ch = (v) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 1000) / 1000;
  const ops = `${ch(c.r)} ${ch(c.g)} ${ch(c.b)} rg\n0 0 ${w} ${h} re\nf\n`;
  return Buffer.from(ops, 'latin1');
}

/**
 * Merge one-page PDFs centered onto the final geometry via pdf-lib.
 * Pure vector rescale: text stays selectable, nothing rasterizes.
 * Copying the source page itself (not embedding it as an XObject) is what
 * preserves hyperlinks: embedPage drops link annotations, copyPages keeps
 * them (remapped to the new page object).
 * When `opts.bgColor` is set, each final page's content stream gets the
 * full-page fill PREPENDED, so the document's own background (e.g. a dark
 * theme) covers the whole sheet, margins included.
 * Metadata is deterministic: fixed timestamps, `tympan:<hash>` keyword,
 * content-derived /ID, tympan Producer — save() runs updateMetadata:false
 * or pdf-lib overwrites Producer/ModDate (verified empirically).
 * @param {Array<{file?: string, pdfBytes?: Buffer}>} items per-section PDFs
 * @param {object} [opts] { title, author, subject, creator, outline,
 *   bgColor, contentHash }
 */
export async function mergeCentered(items, outPath, geo, opts = {}) {
  const dst = await PDFDocument.create();
  if (opts.creator) dst.setCreator(opts.creator);
  if (opts.title) dst.setTitle(opts.title);
  if (opts.author) dst.setAuthor(opts.author);
  if (opts.subject) dst.setSubject(opts.subject);
  const bgStream = opts.bgColor ? buildBackgroundStream(geo.W, geo.H, opts.bgColor) : null;
  const pages = [];
  for (const item of items) {
    const bytes = item.pdfBytes ?? fs.readFileSync(item.file);
    const srcDoc = await PDFDocument.load(bytes);
    const [copied] = await dst.copyPages(srcDoc, [0]);
    const p = srcDoc.getPages()[0];
    const s = Math.min(geo.W / p.getWidth(), geo.H / p.getHeight());
    copied.scaleContent(s, s);
    const w = p.getWidth() * s;
    const h = p.getHeight() * s;
    copied.translateContent((geo.W - w) / 2, (geo.H - h) / 2);
    if (bgStream) {
      // PREPEND the full-page fill: it must paint UNDER the section content,
      // not over it. Replace the Contents array wholesale (robust regardless
      // of pdf-lib's PDFArray mutation surface).
      const oldArr = copied.node.Contents();
      const existing = [];
      for (let i = 0; i < oldArr.size(); i++) existing.push(oldArr.get(i));
      const bgRef = dst.context.register(dst.context.stream(bgStream));
      copied.node.set(PDFName.of('Contents'), dst.context.obj([bgRef, ...existing]));
    }
    const np = dst.addPage(copied);
    np.setSize(geo.W, geo.H);
    pages.push(np);
  }
  if (opts.outline && opts.outline.length) {
    writeOutline(dst, pages, opts.outline);
  }
  dst.setProducer(PRODUCER);
  dst.setCreationDate(FIXED_DATE);
  dst.setModificationDate(FIXED_DATE);
  if (opts.contentHash) dst.setKeywords([`tympan:${opts.contentHash}`]);
  // /ID from the input-derived hash (output bytes would be circular):
  // identical input -> identical /ID.
  const idSeed = opts.contentHash || PRODUCER;
  const idHex = crypto.createHash('sha256').update('tympan-id\0' + idSeed).digest('hex').slice(0, 32);
  const id = PDFHexString.of(idHex);
  dst.context.trailerInfo.ID = dst.context.obj([id, id]);
  const outBytes = await dst.save({ useObjectStreams: false, updateMetadata: false });
  fs.writeFileSync(outPath, outBytes);
}

/**
 * Orchestrate one full pass (master or email) end to end.
 * @param {object} geo resolved geometry {W,H,W_IN,H_IN,contentW,margins}
 */
export async function runPassFull(browser, templateHtml, sections, geo, workdir, onProgress, opts = {}) {
  const pass = await runPass(browser, templateHtml, sections, geo, workdir, onProgress, opts);
  const spills = pass.perSection.filter((p) => p.pages !== 1);
  if (spills.length) {
    throw new Error(`SPILL PAGES (section exceeded one page): ${JSON.stringify(spills)}`);
  }
  // Per-pass filename: the master and email passes share the workdir, and a
  // fixed name would let the second pass CLOBBER the first (found 2026-09-29:
  // with email:true the master output was silently the email variant).
  const outPath = path.join(workdir, (opts.passName || 'pass') + '.pdf');
  await mergeCentered(pass.files.map((f) => ({ file: f })), outPath, geo, opts);
  pass.files.forEach((f) => fs.unlinkSync(f));
  if (onProgress) onProgress('pass-done', { sections: sections.length, outPath });
  return outPath;
}

/**
 * Deterministic input digest: sha256 over the source bytes plus every
 * option that can change output bytes (deliberately NOT paths or the
 * email image stats). Recorded as the PDF's `tympan:<hash>` keyword.
 */
function hashInput(inputPath, options) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(inputPath));
  h.update('options\0');
  h.update(JSON.stringify([
    options.selector ?? null,
    options.format ?? null,
    options.orientation ?? null,
    options.margins ?? null,
    options.contentWidth ?? null,
    options.contentMaxWidth ?? null,
    options.background ?? null,
    options.teaser ?? null,
    options.email ?? false,
    options.outline ?? false,
    options.title ?? null,
    options.author ?? null,
    options.subject ?? null,
  ]));
  return h.digest('hex').slice(0, 16);
}

/**
 * Resolve final-page geometry + content width from options.
 * Portrait is the default — web documents are written top-down and A4
 * portrait is the sheet they mean; landscape remains available for
 * slide-deck-style documents via `--orientation landscape`.
 * @returns {object} {W,H (pt), W_IN,H_IN (inches), contentW (px), margins}
 */
export function resolveGeometry(options = {}) {
  const format = (options.format || 'a4').toLowerCase();
  const base = PAGE_GEOMETRY[format] || PAGE_GEOMETRY.a4;
  const orientation = (options.orientation || 'portrait').toLowerCase();
  const landscape = orientation === 'landscape';
  const margins = { ...DEFAULT_MARGINS, ...(options.margins || {}) };
  const contentW = clampLoadWidth(
    options.contentWidth ?? (landscape ? CONTENT_W : PORTRAIT_CONTENT_W)
  );
  return {
    W: landscape ? base.W : base.H,
    H: landscape ? base.H : base.W,
    W_IN: landscape ? 11.69 : 8.27,
    H_IN: landscape ? 8.27 : 11.69,
    contentW,
    margins,
  };
}

/** Resolve final output paths from options and the input path. */
export function resolveOutputs(inputPath, options = {}) {
  const base = inputPath.replace(/\.html?$/i, '');
  const master = options.out || base + '.pdf';
  const email = options.emailOut || master.replace(/\.pdf$/i, '-email.pdf');
  return { master, email };
}

export async function convert(inputPath, options = {}) {
  const { onProgress } = options;
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  // Fail fast on bad output locations BEFORE launching the browser / doing
  // minutes of print work (a careless -o typo should not cost a full run).
  const outputs = resolveOutputs(inputPath, options);
  for (const f of [outputs.master, ...(options.email ? [outputs.email] : [])]) {
    if (!fs.existsSync(path.dirname(f))) {
      throw new Error(`Output directory not found: ${path.dirname(f)}`);
    }
  }
  const geo = resolveGeometry(options);
  const workdir = makeWorkdir();
  try {
    const browser = await chromium.launch(launchOptions(options));
    try {
      if (onProgress) onProgress('start', { inputPath });
      // Count every blocked request centrally and pass the wrapped progress
      // down so security blocks surface in whatever reporting the caller uses.
      let blockedCount = 0;
      const progress = (event, data) => {
        if (event === 'blocked') blockedCount++;
        if (onProgress) onProgress(event, data);
      };
      const secOpts = { offline: options.offline, allowNet: options.allowNet, onProgress: progress };
      const { templateHtml, detection, prelude, footerHtml, background, contentMaxWidth, docTitle } =
        await loadAndExtract(browser, inputPath, options.selector, {
          loadW: geo.contentW,
          background: options.background,
          contentMaxWidth: options.contentMaxWidth,
          ...secOpts,
        });
      if (onProgress) onProgress('detected', detection);
      // whole-document detection already covers the prelude — don't double it.
      const sections = withPrelude(
        mergeFooter(detection.sections, footerHtml),
        detection.strategy === 'whole-document' ? null : prelude
      );
      const limited = options.teaser ? sections.slice(0, options.teaser) : sections;
      const docOpts = {
        title: options.title || docTitle || null,
        author: options.author || null,
        subject: options.subject || null,
        creator: options.creator || null,
        outline: options.outline
          ? limited.map((s, i) => ({ title: s.title || s.id || `Section ${i + 1}` }))
          : null,
        bgColor: cssColorToRgb(background),
        contentHash: hashInput(inputPath, options),
        offline: options.offline,
        allowNet: options.allowNet,
      };
      if (onProgress) onProgress('print-master', { sections: limited.length });
      const master = await runPassFull(browser, templateHtml, limited, geo, workdir, onProgress, { ...docOpts, passName: 'master' });
      let email = null;
      let emailImgStats = null;
      if (options.email) {
        if (onProgress) onProgress('print-email', {});
        const page = await browser.newPage({ viewport: { width: geo.contentW, height: 1200 } });
        const gateEml = armRequestPolicy(page, { ...secOpts, mainUrl: pathToFileURL(inputPath).href });
        await gateEml.arm();
        await page.goto(pathToFileURL(inputPath).href, { waitUntil: 'networkidle', timeout: 120000 });
        await page.evaluate(() => document.fonts.ready.then(() => true));
        const imgStats = await page.evaluate(downscaleImagesInPage, {
          maxW: options.emailMaxWidth || 1600,
          quality: options.emailQuality || 0.82,
        });
        await page.waitForTimeout(800);
        const detectionEml = await page.evaluate(detectSectionsInPage, options.selector);
        const preludeEml = await page.evaluate(capturePreludeInPage);
        await page.close();
        const sectionsEml = withPrelude(
          mergeFooter(detectionEml.sections, footerHtml),
          detectionEml.strategy === 'whole-document' ? null : preludeEml
        ).slice(0, limited.length);
        email = await runPassFull(browser, templateHtml, sectionsEml, geo, workdir, onProgress, { ...docOpts, passName: 'email' });
        emailImgStats = imgStats;
      }
      fs.copyFileSync(master, outputs.master);
      if (email) fs.copyFileSync(email, outputs.email);
      const result = {
        master: outputs.master,
        email: options.email ? outputs.email : null,
        emailStats: emailImgStats,
        detection,
        contentMaxWidth,
        background,
        blockedRequests: blockedCount,
      };
      if (options.verify !== false) {
        result.verification = await verifyOutputs(result, {
          ...options,
          expectedPages: limited.length,
        });
      }
      return result;
    } finally {
      await browser.close();
    }
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}
