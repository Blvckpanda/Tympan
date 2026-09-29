/**
 * pipeline.js — the core conversion engine.
 *
 * Proven sequence (hard-won on a 24-section investment deck):
 *   1. Load the source HTML in headless Chromium at the content width; wait
 *      for fonts + every image.
 *   2. Detect sections (detect.js) and build the clean-document template
 *      (template.js).
 *   3. Print each section from a fresh clean document onto exactly one page
 *      with shrink-to-fit scale.
 *   4. Merge pages centered onto the final geometry via pdf-lib (vector
 *      rescale — text stays selectable).
 *   5. Verify: page count === section count, zero spill pages.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';
import { launchOptions } from './browser.js';
import { buildCleanTemplate, detectContentMaxWidthInPage, CONTENT_W, DEFAULT_CONTENT_MAX_WIDTH } from './template.js';
import { detectSectionsInPage, describeDetection } from './detect.js';
import { verifyOutputs } from './verify.js';
import { downscaleImagesInPage, mergeFooter } from './email.js';

/** Final page geometry in pt (PDF points, 72/inch), landscape values. */
export const PAGE_GEOMETRY = {
  a4: { W: 841.89, H: 595.28 },
  letter: { W: 792, H: 612 },
};

/** Default page margins in inches (matches the proven deck layout). */
export const DEFAULT_MARGINS = { top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 };

/** Temp workspace for per-section PDFs (caller cleans up). */
export function makeWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'platen-'));
}

/**
 * Load the source HTML and extract, in one visit: the clean-document template,
 * detected sections (HTML + ids), and the footer band (a trailing centered
 * block that gets merged into the last section, as in the proven pipeline).
 */
export async function loadAndExtract(
  browser, inputPath, selector, contentW = CONTENT_W, contentMaxWidth = null
) {
  const page = await browser.newPage({
    viewport: { width: contentW, height: 1200 },
  });
  const url = 'file:///' + encodeURI(inputPath.replace(/\\/g, '/'));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForFunction(
    () => Array.from(document.images).every((i) => i.complete && (i.naturalWidth > 0 || !i.src)),
    null,
    { timeout: 60000 }
  );
  const maxW = contentMaxWidth ?? (await page.evaluate(detectContentMaxWidthInPage, DEFAULT_CONTENT_MAX_WIDTH));
  const templateHtml = await page.evaluate(buildCleanTemplate, maxW);
  const detection = await page.evaluate(detectSectionsInPage, selector);
  const docTitle = await page.evaluate(() => (document.title || '').trim() || null);
  const footerHtml = await page.evaluate(() => {
    const band =
      document.querySelector('main > div.text-center') ||
      document.querySelector('footer');
    return band ? band.outerHTML : null;
  });
  await page.close();
  return { templateHtml, detection, footerHtml, contentMaxWidth: maxW, docTitle };
}

/**
 * Print one section's HTML from a fresh clean document onto ONE page,
 * shrinking just enough when the section is taller than the page.
 * Returns the section's CSS height in px (pre-scale).
 */
export async function printSection(browser, templateHtml, sectionHtml, outPath, geo) {
  const docHtml = templateHtml.replace('<main></main>', '<main>' + sectionHtml + '</main>');
  const page = await browser.newPage({ viewport: { width: geo.contentW, height: 1000 } });
  try {
    await page.setContent(docHtml, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete), null, { timeout: 30000 }).catch(() => {});
    const h = await page.evaluate(() => {
      const el = document.querySelector('main');
      return el ? el.getBoundingClientRect().height : 400;
    });
    const usableH = geo.H_IN - geo.margins.top - geo.margins.bottom;
    // Open-loop measurement cannot be fully trusted: late font swaps make the
    // real print layout taller than measured, and Chromium's print rounding
    // spills sub-pixel remainders onto a second page when the scale lands
    // exactly on the boundary (both observed on tall text documents,
    // 2026-09-29). So the loop is closed: print, count the pages actually
    // produced, and shrink 10% per retry until the section holds its page.
    let scale = Math.min(1, usableH / (h / 96)) * (h / 96 > usableH ? 0.985 : 1);
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
export async function runPass(browser, templateHtml, sections, geo, workdir, onProgress) {
  const files = [];
  const perSection = [];
  const stamp = Date.now();
  for (let i = 0; i < sections.length; i++) {
    const f = path.join(workdir, `pg-${stamp}-${i}.pdf`);
    const h = await printSection(browser, templateHtml, sections[i].html, f, geo);
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
 * Merge one-page PDFs centered onto the final geometry via pdf-lib.
 * Pure vector rescale: text stays selectable, nothing rasterizes.
 * Copying the source page itself (not embedding it as an XObject) is what
 * preserves hyperlinks: embedPage drops link annotations, copyPages keeps
 * them (remapped to the new page object).
 * @param {Array<{file?: string, pdfBytes?: Buffer}>} items per-section PDFs
 * @param {object} [opts] { title, author, subject, creator }
 */
export async function mergeCentered(items, outPath, geo, opts = {}) {
  const dst = await PDFDocument.create();
  // Note: pdf-lib's save() hardcodes its own Producer string; Title/Author/
  // Subject/Creator set here do persist (verified by test).
  if (opts.creator) dst.setCreator(opts.creator);
  if (opts.title) dst.setTitle(opts.title);
  if (opts.author) dst.setAuthor(opts.author);
  if (opts.subject) dst.setSubject(opts.subject);
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
    const np = dst.addPage(copied);
    np.setSize(geo.W, geo.H);
    pages.push(np);
  }
  if (opts.outline && opts.outline.length) {
    writeOutline(dst, pages, opts.outline);
  }
  fs.writeFileSync(outPath, await dst.save({ useObjectStreams: false }));
}

/**
 * Orchestrate one full pass (master or email) end to end.
 * @param {object} geo resolved geometry {W,H,W_IN,H_IN,contentW,margins}
 */
export async function runPassFull(browser, templateHtml, sections, geo, workdir, onProgress, opts = {}) {
  const pass = await runPass(browser, templateHtml, sections, geo, workdir, onProgress);
  const spills = pass.perSection.filter((p) => p.pages !== 1);
  if (spills.length) {
    throw new Error(`SPILL PAGES (section exceeded one page): ${JSON.stringify(spills)}`);
  }
  const outPath = path.join(workdir, `pass-${Date.now()}.pdf`);
  await mergeCentered(pass.files.map((f) => ({ file: f })), outPath, geo, opts);
  pass.files.forEach((f) => fs.unlinkSync(f));
  if (onProgress) onProgress('pass-done', { sections: sections.length, outPath });
  return outPath;
}

/**
 * convert() — the library entry point.
 *
 * @param {string} inputPath absolute path to a self-contained HTML document
 * @param {object} [options]
 * @returns {Promise<object>} { master, email?, detection, verification }
 */
/**
 * Resolve final-page geometry + content width from options.
 * @returns {object} {W,H (pt), W_IN,H_IN (inches), contentW (px), margins}
 */
export function resolveGeometry(options = {}) {
  const format = (options.format || 'a4').toLowerCase();
  const base = PAGE_GEOMETRY[format] || PAGE_GEOMETRY.a4;
  const orientation = (options.orientation || 'landscape').toLowerCase();
  const landscape = orientation !== 'portrait';
  const margins = { ...DEFAULT_MARGINS, ...(options.margins || {}) };
  return {
    W: landscape ? base.W : base.H,
    H: landscape ? base.H : base.W,
    W_IN: landscape ? 11.69 : 8.27,
    H_IN: landscape ? 8.27 : 11.69,
    contentW: options.contentWidth || (landscape ? CONTENT_W : 774),
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
      const { templateHtml, detection, footerHtml, contentMaxWidth, docTitle } = await loadAndExtract(
        browser, inputPath, options.selector, geo.contentW, options.contentMaxWidth
      );
      if (onProgress) onProgress('detected', detection);
      const sections = mergeFooter(detection.sections, footerHtml);
      const limited = options.teaser ? sections.slice(0, options.teaser) : sections;
      const docOpts = {
        title: options.title || docTitle || null,
        author: options.author || null,
        subject: options.subject || null,
        creator: options.creator || null,
        outline: options.outline
          ? limited.map((s, i) => ({ title: s.title || s.id || `Section ${i + 1}` }))
          : null,
      };
      if (onProgress) onProgress('print-master', { sections: limited.length });
      const master = await runPassFull(browser, templateHtml, limited, geo, workdir, onProgress, docOpts);
      let email = null;
      let emailImgStats = null;
      if (options.email) {
        if (onProgress) onProgress('print-email', {});
        const page = await browser.newPage({ viewport: { width: geo.contentW, height: 1200 } });
        await page.goto('file:///' + encodeURI(inputPath.replace(/\\/g, '/')), { waitUntil: 'networkidle', timeout: 120000 });
        await page.evaluate(() => document.fonts.ready.then(() => true));
        const imgStats = await page.evaluate(downscaleImagesInPage, {
          maxW: options.emailMaxWidth || 1600,
          quality: options.emailQuality || 0.82,
        });
        await page.waitForTimeout(800);
        const detectionEml = await page.evaluate(detectSectionsInPage, options.selector);
        await page.close();
        email = await runPassFull(browser, templateHtml, mergeFooter(detectionEml.sections, footerHtml).slice(0, limited.length), geo, workdir, onProgress, docOpts);
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
