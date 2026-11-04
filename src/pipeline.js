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
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';
import { launchOptions } from './browser.js';
import {
  buildCleanTemplate,
  measurePageBackgroundAndWidth,
  clampLoadWidth,
  clampContentWidth,
  CONTENT_W,
  PORTRAIT_CONTENT_W,
  DEFAULT_CONTENT_MAX_WIDTH,
  clampViewportSizedBlocksInPage,
} from './template.js';
import { detectSectionsInPage, capturePreludeInPage, withPrelude } from './detect.js';
import { verifyOutputs } from './verify.js';
import { judgePage, summarizeQuality } from './metrics.js';
import { auditSourceInPage } from './lint.js';
import { auditAccessibilityInPage } from './a11y.js';
import { measureBlockInPage } from './measure.js';
import { chooseLayout } from './auto.js';
import { downscaleImagesInPage, mergeFooter } from './email.js';
import { armRequestPolicy } from './security.js';
import { finalizePdf, applyDeterministicMetadata, dedupeIdenticalStreams, writeOutline } from './finalize.js';import { minifyPdf } from './minify.js';import { stampPdf } from './stamp.js';
import { splitPdf } from './split.js';
import { buildFlowDocument, printFlow, analyzeFlowPdf, verifyFlow, mapSectionsToPages, flowOutlineEntries } from './flow.js';
import { inlineLocalAssets } from './assets.js';
import { estimateTocPages, buildTocHtml } from './toc.js';
import { applyPreset, PRESET_NAMES } from './presets.js';

/** Final page geometry in pt (PDF points, 72/inch) — landscape values. */
export const PAGE_GEOMETRY = {
  a4: { W: 841.89, H: 595.28 },
  letter: { W: 792, H: 612 },
};

/** Default page margins in inches (matches the proven deck layout). */
export const DEFAULT_MARGINS = { top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 };


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
  const url = /^https?:\/\//i.test(inputPath) ? inputPath : pathToFileURL(inputPath).href;
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
  // Custom readiness: wait for a selector the document author controls
  // (charts drawn by JS, lazily mounted sections). After fonts + images;
  // throws a clear error on timeout so CI fails loudly.
  if (opts.waitFor) {
    await page.waitForSelector(opts.waitFor, { timeout: opts.waitTimeout ?? 10000 });
  }
  // Local sibling images the request gate refused get a second chance here:
  // Node reads the file and hands the page a data URI. Nothing is unblocked,
  // and an asset that does not exist stays broken (and stays reported).
  const inlinedAssets = await inlineLocalAssets(page);
  if (inlinedAssets.inlined) {
    // Layout heights can grow once the images actually paint (a sized img is
    // not a zero-height one), so let the page settle again before measuring.
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await page.waitForFunction(
      () => Array.from(document.images).every((i) => i.complete),
      null,
      { timeout: 60000 }
    );
  }
  const measured = await page.evaluate(measurePageBackgroundAndWidth, DEFAULT_CONTENT_MAX_WIDTH);
  const background = opts.background || measured.background;
  // What the document ASKS for (its own container max-width), and what it gets:
  // capped at the printable column so printing never has to scale the page.
  const requestedWidth = opts.contentMaxWidth ?? measured.contentWidth;
  const contentMaxWidth = opts.columnW
    ? clampContentWidth(requestedWidth, opts.columnW)
    : clampLoadWidth(requestedWidth);
  // Playwright evaluate takes exactly ONE serializable arg — bundle them.
  const templateHtml = await page.evaluate(buildCleanTemplate, { maxWidthPx: contentMaxWidth, background });
  // The source's own language, harvested while the original document is in
  // hand: flow-mode tagging prints it onto the print document's <html>, so
  // the tagged writer's /Lang is the document's — never the printing
  // machine's locale fallback (applyTaggedTail deletes that). The clean
  // template is not guaranteed to carry the attribute across.
  const sourceLang = await page.evaluate(() => document.documentElement.lang || null);
  const detection = await page.evaluate(detectSectionsInPage, selector);
  const prelude = await page.evaluate(capturePreludeInPage);
  const docTitle = await page.evaluate(() => (document.title || '').trim() || null);
  // Read-only audit of the source, gathered on the visit we already make: the
  // document's own print CSS, fixed/viewport-sized blocks and images that
  // failed to load. `tympan lint` explains these; nothing here changes output.
  const audit = await page.evaluate(auditSourceInPage);
  // The accessibility audit (SPEC §4 Phase 2's lint half) costs a second
  // body walk with per-element computed styles, so it runs only when lint
  // asks for it: `tympan lint --a11y`. Nothing here changes output either.
  const a11y = opts.auditA11y ? await page.evaluate(auditAccessibilityInPage) : null;
  const footerHtml = await page.evaluate(() => {
    // Trailing band that becomes part of the last page. Ordered: deck-style
    // centered block, semantic <footer>, landing-style trailing .footer div
    // (body-level — the real brief that exposed this used exactly that).
    // The <footer> selectors are DIRECT-CHILD scoped on purpose: a footer
    // nested INSIDE the last section is content, not a band to pull out, and
    // a bare querySelector('footer') grabbed it anyway — mergeFooter then
    // appended a copy of the band into the same section's html, printing the
    // footer text twice (found 2026-11-02 on a Harbor-Gardens-style brief;
    // one copy on the last sheet and one stranded before it in --flow).
    const band =
      document.querySelector('main > div.text-center') ||
      document.querySelector('main > footer') ||
      document.querySelector('body > footer') ||
      document.querySelector('body > .footer');
    return band ? band.outerHTML : null;
  });
  await page.close();
  return {
    templateHtml,
    detection,
    prelude,
    footerHtml,
    background,
    contentMaxWidth,
    contentWidthRequested: Math.round(requestedWidth),
    docTitle,
    audit,
    a11y,
    inlinedAssets,
    sourceLang,
    blocked: gate.blocked(),
  };
}

/**
 * Fonts settle deterministically: a stylesheet `@import` applies after the
 * load event and its font binaries only START loading the next frame, so a
 * single document.fonts.ready can resolve while nothing has been enqueued
 * yet (observed as byte-differing PDFs from the same input under machine
 * load). Proceed only after two consecutive rounds with nothing loading.
 */
async function fontsSettled(page) {
  await page.evaluate(async () => {
    for (let clear = 0, round = 0; clear < 2 && round < 10; round++) {
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      await document.fonts.ready;
      const loading = Array.from(document.fonts).some((f) => f.status === 'loading');
      clear = loading ? 0 : clear + 1;
    }
    return true;
  });
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
    // Viewport-sized blocks (screen `min-height:100vh` covers) must be made
    // absolute BEFORE both the measurement and the print: Chromium re-resolves
    // vh against the print layout viewport (paper/scale), so every shrink
    // step raises the height it tries to fit and the loop can never win.
    const usableH = geo.H_IN - geo.margins.top - geo.margins.bottom;
    const vhClamped = await page.evaluate(clampViewportSizedBlocksInPage, { targetPx: Math.round(usableH * 96) });
    const { h, w, lastBlockKind, brokenImages } = await page.evaluate(measureBlockInPage, 'main');
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
    // Tracked separately from the combined scale: it is the width bound that
    // silently shrinks every page of a document laid out wider than its own
    // printed column, and it is reported as one document-wide finding, not as
    // one "page shrank" per sheet.
    const widthScaleUsed = Math.min(1, usableW / wIn);
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
    let scaleUsed = scale;
    for (let attempt = 0; attempt < 6; attempt++) {
      scaleUsed = scale;
      await page.pdf({ ...pdfOpts, scale });
      const doc = await PDFDocument.load(fs.readFileSync(outPath));
      if (doc.getPageCount() === 1) break;
      scale *= 0.9;
    }
    // The judged page record: the measured DOM height carried through the
    // shrink actually applied, against the usable text area (inches to CSS px
    // at 96/inch, the unit spill.test.mjs reasons in). An estimate by
    // construction — the print lays out at the page width, not the load
    // viewport — but the right shape for flagging a sparse sheet, and immune
    // to the thing that makes coverage metrics useless: a painted background.
    return {
      heightPx: Math.round(h),
      widthPx: Math.round(w),
      scaleUsed,
      widthScaleUsed,
      contentHeightPx: Math.round(h * scaleUsed),
      usableHeightPx: Math.round(usableH * 96),
      vhClamped: vhClamped.clamped,
      lastBlockKind,
      brokenImages,
    };
  } finally {
    await page.close();
  }
}

/**
 * Measure every section for the page it would be printed on, WITHOUT printing.
 *
 * The same layout the printer uses — the clean template at the page's own
 * content width, fonts and images settled — so `tympan preview` can show where
 * the cut will fall and how full each sheet will be before a single byte of
 * PDF exists. The shrink here is the printer's INITIAL estimate; the printer
 * still closes the loop by printing and counting pages, which a preview cannot
 * know. Anything that prints must go through `printSection`.
 *
 * @returns {Promise<Array<object>>} per-section measurements, judged page
 *   records and a screenshot path for each
 */
export async function measureSections(browser, templateHtml, sections, geo, opts = {}) {
  const usableH = geo.H_IN - geo.margins.top - geo.margins.bottom;
  const usableW = geo.W_IN - geo.margins.left - geo.margins.right;
  const out = [];
  for (let i = 0; i < sections.length; i++) {
    const docHtml = templateHtml.replace('<main></main>', '<main>' + sections[i].html + '</main>');
    const page = await browser.newPage({ viewport: { width: geo.contentW, height: 1000 } });
    const gate = armRequestPolicy(page, {
      offline: opts.offline,
      allowNet: opts.allowNet,
      onProgress: opts.onProgress,
    });
    await gate.arm();
    try {
      await page.setContent(docHtml, { waitUntil: 'load' });
      await fontsSettled(page);
      await page
        .waitForFunction(() => Array.from(document.images).every((i) => i.complete), null, { timeout: 30000 })
        .catch(() => {});
      // Same dimensional fix as printSection: preview numbers and the layout
      // auto chooser must describe the SAME blocks the print pass will lay
      // out; a vh cover measured live here would disagree with its sheet.
      const vhClamped = await page.evaluate(clampViewportSizedBlocksInPage, {
        targetPx: Math.round(usableH * 96),
      });
      const m = await page.evaluate(measureBlockInPage, 'main');
      const hIn = m.h / 96;
      const wIn = m.w / 96;
      const heightBound = hIn > usableH;
      const scaleUsed = Math.min(1, usableH / hIn, usableW / wIn) * (heightBound ? 0.985 : 1);
      let shot = null;
      if (opts.shotDir && m.h > 0 && m.h <= 8000) {
        const file = path.join(opts.shotDir, `sheet-${i}.jpg`);
        try {
          await page.locator('main').screenshot({ path: file, type: 'jpeg', quality: 78 });
          shot = file;
        } catch {
          shot = null; // a preview without its picture is still a preview
        }
      }
      out.push({
        id: sections[i].id,
        title: sections[i].title ?? null,
        heightPx: Math.round(m.h),
        widthPx: Math.round(m.w),
        scaleUsed,
        widthScaleUsed: Math.min(1, usableW / wIn),
        contentHeightPx: Math.round(m.h * scaleUsed),
        usableHeightPx: Math.round(usableH * 96),
        lastBlockKind: m.lastBlockKind,
        brokenImages: m.brokenImages,
        vhClamped: vhClamped.clamped,
        shot,
      });
      if (opts.onProgress) opts.onProgress('measured', { index: i + 1, total: sections.length, id: sections[i].id });
    } finally {
      await page.close();
    }
  }
  return out;
}

/**
 * Print every section to its own one-page PDF; returns per-section info.
 */
export async function runPass(browser, templateHtml, sections, geo, workdir, onProgress, opts = {}) {
  const files = [];
  const perSection = [];
  for (let i = 0; i < sections.length; i++) {
    const f = path.join(workdir, `pg-${i}.pdf`);
    const measure = await printSection(browser, templateHtml, sections[i].html, f, geo, opts);
    const doc = await PDFDocument.load(fs.readFileSync(f));
    const pages = doc.getPageCount();
    perSection.push({ id: sections[i].id, pages, ...measure });
    files.push(f);
    if (onProgress) onProgress('section', { index: i + 1, total: sections.length, id: sections[i].id, pages });
  }
  return { files, perSection };
}

// (writeOutline moved to finalize.js so flow mode can write it on a loaded
// document — one implementation, both producers)

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
  // Shared with flow mode (finalize.js), which prints outside pdf-lib and
  // finalises the bytes on disk — same Producer, same dates, same /ID rule.
  applyDeterministicMetadata(dst, opts);
  // Content-identical resources arrive duplicated. Measured: Chromium subsets
  // fonts PER SECTION PRINT (28 /FontFile copies on the Kitch deck) and their
  // contents are distinct, so only content-level dedup is trip-safe here —
  // the byte-level collapse the plan measured comes from `--flow` printing
  // the body once instead of once per section.
  const deduped = dedupeIdenticalStreams(dst);
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
  return { outPath, perSection: pass.perSection };
}

/**
 * Deterministic input digest: sha256 over the source bytes (or the URL, for
 * remote inputs — the fetch happens later, and a changed document behind a
 * stable URL is a different-input problem, not a determinism bug) plus every
 * option that can change output bytes. Recorded as the PDF's keyword.
 */
export function hashInput(inputPath, options) {
  const h = crypto.createHash('sha256');
  if (/^https?:\/\//i.test(inputPath)) {
    h.update('url\0' + inputPath);
  } else {
    h.update(fs.readFileSync(inputPath));
  }
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
    options.waitFor ?? null,
    options.waitTimeout ?? null,
  ]));
  // Flow is opt-in, and its options are hashed ONLY when it is on: adding a
  // key to the array above would change the digest (and therefore every byte)
  // of section-mode output for existing users, which this release must not do.
  // NOTE: this if lives OUTSIDE the block comment on purpose. It was once
  // glued to the last comment line, and then --flow, --page-numbers and
  // fill presets never reached the digest: two competing configurations
  // could report the same input hash. This line must execute.
  if (options.flow) h.update('flow\0' + (options.pageNumbers ? 'page-numbers' : ''));

  // W2/W3 options change bytes too, but they are all opt-in: hashing them
  // only when set keeps the digest (and therefore every byte) of a default
  // section-mode run EXACTLY where v0.7 left it.
  if (options.layout === 'auto' || options.toc || options.pageFooter || (options.fill && options.fill !== 'balanced')) {
    h.update(
      'extra\0' +
        JSON.stringify({
          layout: options.layout || null,
          toc: !!options.toc,
          pageFooter: options.pageFooter || null,
          fill: options.fill || null,
        })
    );
  }
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
  // Inches are DERIVED from the chosen format's points (72/inch), never
  // hard-coded: `--format letter` used to print into an A4-shaped box
  // (8.27x11.69in) and then merge onto a 612x792pt letter page, so the page
  // Chromium laid out was not the page the document landed on. Found by the
  // preview's sheet-size test, 2026-10-16.
  const round2 = (n) => Math.round(n * 100) / 100;
  const W_IN = round2((landscape ? base.W : base.H) / 72);
  const H_IN = round2((landscape ? base.H : base.W) / 72);
  // The printable column: the sheet minus its side margins. This is the width
  // Chromium lays the printed page out in, so it is the ceiling for the
  // layout — see clampContentWidth for the 0.902 story.
  const columnW = Math.round((W_IN - margins.left - margins.right) * 96);
  if (!(columnW > 0) || !(H_IN - margins.top - margins.bottom > 0)) {
    throw new Error(
      `margins leave no printable area: ${margins.left}+${margins.right}in of a ${W_IN}in sheet, ` +
        `${margins.top}+${margins.bottom}in of ${H_IN}in`
    );
  }
  // Layout width for the printed page: detected/requested width, capped at the
  // column. `--content-width` can narrow it; nothing can widen it past paper.
  const contentW = clampContentWidth(options.contentWidth ?? columnW, columnW);
  // Width the SOURCE is rendered at while measuring. Deliberately not the
  // print width: a 1026px deck measured at 698px would trip its own tablet
  // media queries, so detection would describe a page nobody prints.
  const loadW = clampLoadWidth(landscape ? CONTENT_W : PORTRAIT_CONTENT_W);
  return {
    W: landscape ? base.W : base.H,
    H: landscape ? base.H : base.W,
    W_IN,
    H_IN,
    columnW,
    contentW,
    loadW,
    margins,
  };
}

/** Resolve final output paths from options and the input path or URL. */
export function resolveOutputs(inputPath, options = {}) {
  const isUrl = /^https?:\/\//i.test(inputPath);
  let base;
  if (isUrl) {
    // Derive a filename from the URL path's last segment; fall back sensibly.
    let seg = '';
    try {
      seg = decodeURIComponent(new URL(inputPath).pathname.split('/').filter(Boolean).pop() || '');
    } catch { /* keep empty */ }
    base = seg.replace(/\.html?$/i, '') || 'tympan-output';
  } else {
    base = inputPath.replace(/\.html?$/i, '');
  }
  const master = options.out || base + '.pdf';
  const email = options.emailOut || master.replace(/\.pdf$/i, '-email.pdf');
  return { master, email };
}

export async function convert(inputPath, raw = {}) {
  // A preset is a documented bundle of defaults folded UNDER explicit options
  // (src/presets.js). Applied here, not just in the CLI, so the HTTP API can
  // use the same vocabulary; the CLI validates the name for a friendly error.
  const options = raw.preset ? applyPreset(raw.preset, raw) : raw;
  if (raw.preset && !PRESET_NAMES.includes(raw.preset)) {
    throw new Error(`unknown preset "${raw.preset}" (known presets: ${PRESET_NAMES.join(', ')})`);
  }
  const { onProgress } = options;
  const isUrl = /^https?:\/\//i.test(inputPath);  if (!isUrl && !fs.existsSync(inputPath)) {
    throw new Error(`Input not found: ${inputPath}`);
  }
  // A watermark is semantics, not plumbing: a blank one cannot be silenced
  // later, so looking at it costs nothing here and everything if we wait
  // until after the browser has printed.
  if (options.watermark != null && String(options.watermark).trim() === '') {
    throw new Error('watermark: text is required (non-empty)');
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
    // A caller-supplied browser (batch runs reuse one launch) outlives this
    // call; one we launched ourselves is closed here. Two try levels, two
    // ownership rules: the inner one owns the browser, the outer the workdir.
    const owned = options.browser ? null : await chromium.launch(launchOptions(options));
    const browser = options.browser || owned;
    try {
      if (onProgress) onProgress('start', { inputPath });
      // Count every blocked request centrally and pass the wrapped progress
      // down so security blocks surface in whatever reporting the caller uses.
      let blockedCount = 0;
      const blockedDetails = [];
      const progress = (event, data) => {
        if (event === 'blocked') {
          blockedCount++;
          // Keep the reason and a bounded sample of URLs: a count alone cannot
          // tell "you asked for offline mode" from "your logo never loaded".
          if (blockedDetails.length < 50) blockedDetails.push({ url: data.url, reason: data.reason });
        }
        if (onProgress) onProgress(event, data);
      };
      const secOpts = { offline: options.offline, allowNet: options.allowNet, onProgress: progress };
      const {
        templateHtml,
        detection,
        prelude,
        footerHtml,
        background,
        contentMaxWidth,
        contentWidthRequested,
        docTitle,
        audit,
        a11y,
        inlinedAssets,
        sourceLang,
      } = await loadAndExtract(browser, inputPath, options.selector, {
          loadW: geo.loadW,
          columnW: geo.columnW,
          background: options.background,
          // `contentWidth` is the documented layout width; contentMaxWidth is
          // the older name for the same thing. Either narrows the layout, and
          // the column cap still applies.
          contentMaxWidth: options.contentWidth ?? options.contentMaxWidth,
          waitFor: options.waitFor,
          waitTimeout: options.waitTimeout,
          auditA11y: !!options.auditA11y,
          ...secOpts,
        });
      if (onProgress) onProgress('detected', detection);
      // whole-document detection already covers the prelude — don't double it.
      const sections = withPrelude(
        mergeFooter(detection.sections, footerHtml),
        detection.strategy === 'whole-document' ? null : prelude
      );
      const limited = options.teaser ? sections.slice(0, options.teaser) : sections;
      // ---------------------------------------------------- layout auto
      // Explicit --flow always wins. With --layout auto the chooser measures
      // every section first (the numbers printSection starts from) and picks
      // flow only when the plan's rule says so: more sheet area wasted than
      // the target allows, or a section starting to shrink below the floor.
      // The result states what was picked AND the arithmetic behind it.
      let layoutChoice = null;
      let useFlow = options.flow === true;
      if (!useFlow && options.layout === 'auto') {
        const measured = await measureSections(browser, templateHtml, limited, geo, { ...secOpts, waitFor: options.waitFor, waitTimeout: options.waitTimeout });
        layoutChoice = chooseLayout({
          sections: measured,
          usablePx: Math.round((geo.H_IN - geo.margins.top - geo.margins.bottom) * 96),
          targetFill: options.targetFill ?? 0.7,
        });
        if (onProgress) onProgress('layout-chosen', layoutChoice);
        useFlow = layoutChoice.picked === 'flow';
      }
      // The digest must reflect the layout the run actually used, or two
      // runs of the same input with the same auto options could share a /ID
      // while producing a different number of pages.
      const hashedOpts = useFlow && !options.flow ? { ...options, flow: true } : options;
      const docOpts = {
        title: options.title || docTitle || null,
        author: options.author || null,
        subject: options.subject || null,
        creator: options.creator || null,
        outline: options.outline
          ? limited.map((s, i) => ({
              title: s.title || s.id || `Section ${i + 1}`,
              page: (options.toc ? estimateTocPages(limited.length) : 0) + i,
            }))
          : null,
        bgColor: cssColorToRgb(background),
        contentHash: hashInput(inputPath, hashedOpts),
        offline: options.offline,
        allowNet: options.allowNet,
      };
      // ---------------------------------------------------------- flow
      // Opt-in: let Chromium paginate the whole body once. Nothing is
      // merged, so the deterministic tail runs on the printed file, and every
      // page record is measured from that file rather than from the DOM (the
      // DOM has no idea where Chromium broke the pages).
      if (useFlow) {
        if (options.email) {
          throw new Error('--email is section-mode only: flow mode prints one document, not a downscaled variant');
        }
        const runningFooter = options.pageFooter || (options.footerFromTitle && docTitle ? docTitle : null);
        // `--fill tight` (plan section 3.4): a bounded candidate ladder, NOT an
        // open shrink loop. Each candidate is one deterministic scale over the
        // WHOLE body (uniform within the document), the floor is 0.97 by
        // construction, and the winner is reported with its arithmetic.
        const candidates = options.fill === 'tight' ? [1, 0.98, 0.97] : [1];
        const attempts = [];
        for (const candidate of candidates) {
          if (onProgress) onProgress('print-flow', { sections: limited.length, scale: candidate });
          const flowHtml = buildFlowDocument(templateHtml, limited.map((s) => s.html).join('\n'), {
            pageNumbers: !!options.pageNumbers,
            pageFooter: runningFooter,
            fill: options.fill,
            lang: sourceLang,
          });
          const rawPath = path.join(workdir, `flow-raw-${candidate}.pdf`);
          const thisDom = await printFlow(browser, flowHtml, rawPath, geo, {
            ...secOpts,
            waitFor: options.waitFor,
            waitTimeout: options.waitTimeout,
            scale: candidate,
            tagged: !!options.tagged,
          });
          const thisAnalysis = await analyzeFlowPdf(rawPath, geo);
          attempts.push({ scale: candidate, pages: thisAnalysis.pageCount, analysis: thisAnalysis, dom: thisDom, rawPath });
        }
        // Fewest pages wins; ties go to the larger scale (a real near-fit is
        // the only thing that justifies shrinking, and shrinking never buys a
        // tie). Deterministic by construction — the ladder is fixed.
        attempts.sort((a, b) => a.pages - b.pages || b.scale - a.scale);
        const analysis = attempts[0].analysis;
        const dom = attempts[0].dom;
        const chosenScale = attempts[0].scale;
        const fillPolicy = candidates.length > 1
          ? { policy: options.fill, scaleApplied: chosenScale, candidates: candidates.map((c) => c), attempts: attempts.map((a) => ({ scale: a.scale, pages: a.pages })) }
          : null;
        if (onProgress) onProgress('flow-chosen', { scale: chosenScale, pages: analysis.pageCount });
        // TOC (plan W3): one entry per section, sheet numbers measured from
        // a pass WITHOUT the TOC, then corrected when the TOC's own sheets
        // shift the numbering. Bounded at 3 convergence passes; the result
        // reports whether it converged. The ladder above already picked the
        // tight candidate, so TOC prints reuse it — determinism is per
        // option set, and the TOC never re-opens the fill decision.
        let finalAnalysis = analysis;
        let printedDom = dom;
        let rawUsed = attempts[0].rawPath;
        let tocInfo = null;
        if (options.toc) {
          const tocSheets = estimateTocPages(limited.length);
          // In flow mode the TOC is a BLOCK, not a guaranteed sheet — it can
          // share sheet 1 with the first sections. So there is no fixed
          // offset: the mapping runs over every sheet with lead anchors
          // (titles never appear in rows), and printing real sheet numbers
          // is what the convergence loop works toward.
          const sheetFallback = (numbers, i) =>
            numbers[i] ?? (i > 0 ? numbers[i - 1] + 1 : 1);
          let numbers = mapSectionsToPages(analysis, limited, { preferLead: true });
          for (let iter = 0; iter < 3; iter++) {
            const entries = limited.map((s, i) => ({
              title: s.title ?? null,
              id: s.id,
              page: sheetFallback(numbers, i),
            }));
            const bodyHtml = buildTocHtml(entries) + '\n' + limited.map((s) => s.html).join('\n');
            rawUsed = path.join(workdir, `flow-toc-${iter}.pdf`);
            printedDom = await printFlow(
              browser,
              buildFlowDocument(templateHtml, bodyHtml, {
                pageNumbers: !!options.pageNumbers,
                pageFooter: runningFooter,
                fill: options.fill,
                lang: sourceLang,
              }),
              rawUsed,
              geo,
              { ...secOpts, waitFor: options.waitFor, waitTimeout: options.waitTimeout, scale: chosenScale, tagged: !!options.tagged }
            );
            finalAnalysis = await analyzeFlowPdf(rawUsed, geo);
            const mapped = mapSectionsToPages(finalAnalysis, limited, { preferLead: true });
            const matched = mapped.every((p, i) => (numbers[i] ?? -1) === p);
            tocInfo = { pages: tocSheets, entries: entries.length, stable: matched, iterations: iter + 1, numbers: mapped.map((p, i) => p ?? sheetFallback(numbers, i)) };
            if (matched) break;
            numbers = mapped.map((p, i) => p ?? numbers[i]);
          }
        }
        if (onProgress && finalAnalysis !== analysis && options.toc) {
          onProgress('toc-settled', { pages: finalAnalysis.pageCount, stable: tocInfo && tocInfo.stable });
        }
        const medianText = finalAnalysis.medianTextHeight || 0;
        const pages = finalAnalysis.pages.map((p) =>
          judgePage({
            index: p.index,
            sectionId: null,
            contentHeightPx: p.contentHeightPx,
            usableHeightPx: p.usableHeightPx,
            // The scale is 1 because it flowed — except in opt-in `--fill
            // tight`, where the bounded winning candidate is carried, never
            // assumed.
            scaleApplied: chosenScale,
            widthScale: 1,
            lastBlockKind: medianText && p.lastTextHeight >= medianText * 1.25 ? 'heading' : 'text',
            // Chromium never reports which page a DOM block landed on, so a
            // split keep-together block cannot be detected from the PDF. Null
            // is "unmeasured"; it must never read as "verified clean".
            keptTogether: null,
          }, { layout: 'flow' }) // the mode this branch IS: no section judgement field
        );
        for (const p of pages) p.measuredFrom = 'pdf';
        // The mode this branch set stamps and records just above — said, not
        // inferred (flowOutput's stamp inference remains for callers that
        // genuinely do not know).
        const quality = summarizeQuality(pages, { targetFill: options.targetFill, layout: 'flow' });
        // Outline (plan section 3.5): flow mode now SUPPORTS auto bookmarks —
        // each section's heading is located in the PDF's own text layer and
        // the outline gets a real destination, one page for prose documents.
        let outlineEntries = null;
        if (options.outline) {
          // Same anchors as the TOC mapping (leads win when the TOC is
          // printed) — the outline must point where the reader really lands.
          const mapped = mapSectionsToPages(finalAnalysis, limited, { preferLead: !!options.toc });
          const titles = limited.map((s, i) => s.title || s.id || `Section ${i + 1}`);
          outlineEntries = flowOutlineEntries(titles, mapped);
        }
        const finalPath = path.join(workdir, 'flow-final.pdf');
        await finalizePdf(rawUsed, finalPath, {
          ...docOpts,
          outline: outlineEntries,
          tagged: options.tagged === true,
          lang: printedDom.lang || dom.lang || null,
        });
        fs.copyFileSync(finalPath, outputs.master);
        // SPEC §4 Phase 2 size pass: rewrite the file (objstm + xref stream),
        // never the document. Runs before the size is measured, so the
        // verification report carries the bytes a reader actually gets. A
        // refusal (encrypted/incremental) degrades to the unminified file.        // SPEC §4 Phase 2 stamping: semantics first, size pass second — the
        // stamp lands on the file the minify pass will then compact. A stamp        // failure is a loud failure (unlike a minify refusal): an unstamped        // file that looks watermarked is worse than an error.
        const stampResult = options.watermark ? await applyStampTo(outputs.master, options.watermark) : null;
        let minifyResult = null;
        if (options.minify) minifyResult = applyMinifyTo(outputs.master);
        // Splitting reads the finished, compact master: parts inherit the
        // stamp's semantics and the minify pass's form.
        const splitResult = options.split ? await applySplitTo(outputs.master) : null;
        const strandedHeadingPages = pages.filter((p) => p.strandedHeading).map((p) => p.index);
        const blocked = {
          ...audit,
          sourceBrokenImages: audit?.brokenImages || [],
          brokenImages: [], // per-page image failures need the DOM; flow measures the PDF
          blockedRequests: blockedDetails,
        };
        const verification = verifyFlow(finalAnalysis, {
          probe: options.probe,
          overflowPx: printedDom.overflowPx,
          strandedHeadingPages,
          keepTogetherBlocks: printedDom.keepTogetherBlocks,
          scale: chosenScale,
          fillPolicy,
          sizeBytes: fs.statSync(outputs.master).size,
        });
        if (onProgress) onProgress('pass-done', { sections: limited.length, outPath: outputs.master });
        return {
          master: outputs.master,
          email: null,
          emailStats: null,
          detection,
          contentMaxWidth,
          contentWidthRequested,
          geometry: geo,
          background,
          blockedRequests: blockedCount,
        layout: 'flow',
          layoutChoice,
          assetInlining: inlinedAssets,
          a11y,
          pageNumbers: !!options.pageNumbers,
          pageFooter: runningFooter || null,
          toc: tocInfo,
          fillPolicy: fillPolicy,
          outline: outlineEntries ? { entries: outlineEntries.length, mappedBy: 'text-layer' } : null,
          pages,
          quality,
          audit: blocked,
          flow: {
            overflowPx: printedDom.overflowPx,
            widthPx: printedDom.widthPx,
            pageNumbers: !!options.pageNumbers,
            keepTogetherBlocks: printedDom.keepTogetherBlocks,
          },
          verification,          minify: minifyResult,
          stamp: stampResult,
          split: splitResult,
          tagged: options.tagged === true ? { applied: true, lang: printedDom.lang || null } : null,
        };
      }

      // ------------------------------------------------------------ deck
      // Tagged output is a flow-only shape: deck mode prints one PDF per
      // section and merges them, so the merged document has no single
      // structure tree to carry. Fail loudly with the pointer to --flow.
      if (options.tagged) {
        throw new Error(
          '--tagged applies to --flow only: deck mode merges one print per section, so the merged document cannot carry one structure tree. Pass --flow (or --layout flow) with --tagged.'
        );
      }
      if (onProgress) onProgress('print-master', { sections: limited.length });
      // `--toc` in section mode is simple arithmetic: every section prints as
      // exactly one sheet (that is the mode's invariant), so the TOC's sheet
      // count fixes every number before a single print happens. No convergence
      // loop needed; the report says so.
      const tocSheets = options.toc ? estimateTocPages(limited.length) : 0;
      const printedSections = options.toc
        ? [
            {
              id: 'tympan-toc',
              title: 'Contents',
              html: buildTocHtml(
                limited.map((s, i) => ({ title: s.title ?? null, id: s.id, page: tocSheets + i + 1 }))
              ),
            },
            ...limited,
          ]
        : limited;
      const masterPass = await runPassFull(browser, templateHtml, printedSections, geo, workdir, onProgress, { ...docOpts, passName: 'master' });
      const master = masterPass.outPath;
      let email = null;
      let emailImgStats = null;
      if (options.email) {
        if (onProgress) onProgress('print-email', {});
        const page = await browser.newPage({ viewport: { width: geo.loadW, height: 1200 } });
        const gateEml = armRequestPolicy(page, { ...secOpts, mainUrl: pathToFileURL(inputPath).href });
        await gateEml.arm();
        await page.goto(pathToFileURL(inputPath).href, { waitUntil: 'networkidle', timeout: 120000 });
        await page.evaluate(() => document.fonts.ready.then(() => true));
        if (options.waitFor) {
          await page.waitForSelector(options.waitFor, { timeout: options.waitTimeout ?? 10000 });
        }
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
        // The email variant carries no TOC: it is a downscaled reading copy,
        // and its section list is built from a fresh detection pass.
        email = (await runPassFull(browser, templateHtml, sectionsEml, geo, workdir, onProgress, { ...docOpts, passName: 'email' })).outPath;
        emailImgStats = imgStats;
      }
      fs.copyFileSync(master, outputs.master);
      if (email) fs.copyFileSync(email, outputs.email);      // Stamping runs before the size pass for the same reason as above, and
      // both artifacts carry it: the email variant is this document too.
      const stampResult = options.watermark ? await applyStampTo(outputs.master, options.watermark) : null;
      if (options.watermark && email) {
        await applyStampTo(outputs.email, options.watermark);
      }
      const minifyResult = options.minify ? applyMinifyTo(outputs.master) : null;
      // Same rule as flow mode: parts are copies of the finished master.
      const splitResult = options.split ? await applySplitTo(outputs.master) : null;
      const result = {
        master: outputs.master,
        email: options.email ? outputs.email : null,
        emailStats: emailImgStats,
        detection,
        contentMaxWidth,
        contentWidthRequested,
        geometry: geo,
        background,
        blockedRequests: blockedCount,
        layout: 'section',
        layoutChoice,
        assetInlining: inlinedAssets,
        a11y,
        pageFooter: options.pageFooter || (options.footerFromTitle && docTitle ? docTitle : null),
        toc: options.toc
          ? {
              pages: tocSheets,
              entries: limited.length,
              stable: true,
              iterations: 0,
              numbers: limited.map((s, i) => tocSheets + i + 1),
            }
          : null,
        // One record per printed page, index-aligned with the final PDF, so a
        // report can say WHICH page is half empty instead of averaging the
        // problem away. Measured in the DOM before the print, never read off
        // the rendered pixels.
        pages: masterPass.perSection.map((p, i) => judgePage({
          index: i + 1,
          sectionId: p.id,
          contentHeightPx: p.contentHeightPx,
          usableHeightPx: p.usableHeightPx,
          scaleApplied: p.scaleUsed,
          widthScale: p.widthScaleUsed,
          lastBlockKind: p.lastBlockKind,
          // Section layout prints a section onto exactly one page, so a
          // break-inside:avoid block cannot split here and nothing is traded
          // away. Flow layout measures this for real.
          keptTogether: true,
        })),        minify: minifyResult,
        stamp: stampResult,
        split: splitResult,
      };
      result.quality = summarizeQuality(result.pages, { targetFill: options.targetFill });
      // Everything the document asked for and did not get, carried with the
      // result so `tympan lint` can name one lost image instead of only
      // reporting a sparse page. `brokenImages` is per printed page (what the
      // PDF is missing); `sourceBrokenImages` is what the author's own page
      // could not load — the fallback when sections dropped the reference
      // entirely.
      result.audit = {
        ...audit,
        sourceBrokenImages: audit?.brokenImages || [],
        brokenImages: masterPass.perSection.flatMap((p, i) =>
          (p.brokenImages || []).map((b) => ({ ...b, page: i + 1 }))
        ),
        blockedRequests: blockedDetails,
      };
      if (options.verify !== false) {
        result.verification = await verifyOutputs(result, {
          ...options,
          expectedPages: options.toc ? limited.length + tocSheets : limited.length,
        });
      }
      return result;
    } finally {
      if (owned) await browser.close();
    }
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
  }
}

/**
 * SPEC §4 Phase 2: rewrite a produced master in place via minifyPdf — same
 * document, deflated plumbing (object streams + one xref stream). Returns
 * the pass stats; on refusal returns { refused: reason } and leaves the
 * file untouched, because a size pass must never be able to break a
 * conversion that already succeeded.
 * @param {string} file absolute path of the master PDF
 * @returns {object} minify stats, or { refused: string }
 */function applyMinifyTo(file) {
  try {
    const src = fs.readFileSync(file);
    const { pdf, stats } = minifyPdf(src);
    fs.writeFileSync(file, pdf);
    return stats;
  } catch (e) {
    return { refused: (e && e.message) || String(e) };
  }
}

/**
 * SPEC §4 Phase 2: stamp the watermark (Semantics, size-neutral) onto a
 * produced file, in place. Throws on failure — a conversion that LOOKS
 * watermarked but is not must never exist.
 * @param {string} file absolute path of the PDF to stamp
 * @param {string} text the watermark text
 * @returns {Promise<{pages: number, text: string}>} what the report carries
 */async function applyStampTo(file, text) {
  return stampPdf(file, text);
}

/**
 * SPEC §4 Phase 2: split the finished master into per-sheet artifacts.
 * Runs LAST (after stamp, after minify) so a part is exactly what the
 * master carries, in the compact form the minify pass produced. Throws on
 * failure — a split that silently skipped a page would be a report that
 * undercounts what a reader receives.
 * @param {string} file absolute path of the master PDF
 * @returns {Promise<{parts: number, files: string[]}>}
 */
async function applySplitTo(file) {
  return splitPdf(file);
}

/**
 * Convert several inputs through ONE warm Chromium launch.
 *
 * Batch runs pay browser startup once instead of per file. A failure is
 * contained: the remaining inputs still convert, every entry carries its own
 * ok/error. Sequential on purpose — Chromium printing is CPU-bound, so
 * parallel jobs buy little and cost determinism.
 *
 * An entry is `ok` only when the conversion succeeded AND self-verification
 * passed (page count, spill guard, probe), so callers can gate CI on `ok`
 * exactly as they gate on the single-input exit code.
 *
 * @param {string[]} inputs file paths or URLs
 * @param {object} [options] convert() options, plus
 *   perInput?: (input: string, index: number) => object — per-input overrides
 *   (typically `out`, since a batch has no single output path)
 * @returns {Promise<{ok: boolean, entries: Array<{input: string, ok: boolean,
 *   result: object|null, error: string|null}>}>}
 */
export async function convertMany(inputs, options = {}) {
  const list = (Array.isArray(inputs) ? inputs : [inputs]).filter((i) => i != null);
  if (list.length === 0) throw new Error('convertMany: no inputs');
  const { perInput, ...shared } = options;
  const owned = shared.browser ? null : await chromium.launch(launchOptions(shared));
  const browser = shared.browser || owned;
  const entries = [];
  try {
    for (let i = 0; i < list.length; i++) {
      const input = list[i];
      const overrides = perInput ? perInput(input, i) || {} : {};
      // A per-input progress handler (the golden runner) speaks for itself.
      if (shared.onProgress && !overrides.onProgress) {
        shared.onProgress('batch-input', { input, index: i + 1, total: list.length });
      }
      try {
        const result = await convert(input, { ...shared, ...overrides, browser });
        const verified = !result.verification || result.verification.ok !== false;
        entries.push({ input, ok: verified, result, error: verified ? null : 'verification failed' });
      } catch (e) {
        entries.push({ input, ok: false, result: null, error: (e && e.message) || String(e) });
      }
    }
  } finally {
    if (owned) await browser.close();
  }
  return { ok: entries.every((e) => e.ok), entries };
}
