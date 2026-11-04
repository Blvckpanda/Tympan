/**
 * flow.js — `--flow`: let Chromium paginate the whole body, once.
 *
 * Section mode prints one section per sheet, which is right for a deck and
 * wrong for prose: a 400px section cannot fill a 1,045px sheet, so fill is
 * capped by the document's structure rather than its whitespace. Measured on
 * the Kitch deck (2026-10-21): 10 sheets at 64% mean fill, two sections shrunk
 * for height because a narrower measure made them taller than a page.
 *
 * Flow mode prints ONE document containing the whole body with print CSS
 * injected for breaks, and Chromium paginates it. It flows instead of
 * shrinking, so `scaleApplied` is 1 by construction — and the page count is
 * whatever the content needs, not whatever the section count demands.
 *
 * Two consequences the pipeline must respect:
 *
 *   1. There is nothing to merge, so the deterministic tail moves to
 *      finalize.js and runs on the printed file.
 *   2. Measurement has to happen on the PDF, because the DOM does not know
 *      where Chromium broke the pages. Fill, blank pages and clipping are read
 *      back from the produced file — which is also the number a reviewer can
 *      check for themselves.
 *
 * What Chromium does not give us is a map from a DOM block to a page, so a
 * split `break-inside: avoid` block cannot be detected here. That is reported
 * as `keepTogether: {measured: false}` — explicitly unmeasured, never a silent
 * "true".
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { armRequestPolicy } from './security.js';
import { probeRegex } from './verify.js';
import { clampViewportSizedBlocksInPage } from './template.js';

// Fonts settle deterministically: a stylesheet `@import` applies after the
// load event and its font binaries only START loading the next frame, so a
// single document.fonts.ready can resolve while nothing has been enqueued
// yet (observed as byte-differing PDFs from the same input under machine
// load). Proceed only after two consecutive rounds with nothing loading.
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

/** Blocks that must not split across a sheet unless they cannot fit at all. */
export const FLOW_KEEP_TOGETHER = 'figure, table, pre, blockquote, img, svg';

/** The extended set `--fill loose` keeps unsplit. Gaps are accepted. */
export const FLOW_KEEP_TOGETHER_LOOSE = FLOW_KEEP_TOGETHER + ', li, dd, dt';

/**
 * Legal CSS string for a margin-box content value.
 * @param {string} text
 * @returns {string}
 */
export function cssString(text) {
  return JSON.stringify(String(text).slice(0, 200));
}

/**
 * CSS injected into the clean template for flow printing.
 *
 * `break-inside: avoid` is an avoidance request, not a guarantee (CSS Break 3):
 * Chromium will still split a block taller than a page, because fragmentation
 * has to make progress. The rules below are therefore about ordinary cases,
 * and verification measures the ones that can be measured.
 * @param {{pageNumbers?: boolean, pageFooter?: string, fill?: string}} [opts]
 * @returns {string}
 */
export function flowCss(opts = {}) {
  const rules = [
    'section, article { break-inside: auto }',
    'h1, h2, h3, h4, h5, h6 { break-after: avoid; break-inside: avoid }',
    'p, li, dd, dt { orphans: 2; widows: 2 }',
    `${opts.fill === 'loose' ? FLOW_KEEP_TOGETHER_LOOSE : FLOW_KEEP_TOGETHER} { break-inside: avoid }`,
  ];
  // Chrome 131+ page-margin boxes: the only way to get real page numbers into
  // a single Chromium print, because counter(page)/counter(pages) are resolved
  // by the print engine and the merge step that used to rebuild pages is gone.
  // One @page rule hosts every margin box; a static running footer (Blink has
  // no string-set, so per-page dynamic text is not possible) goes left, the
  // counter center — verified extractable on the pinned engine by test.
  if (opts.pageNumbers || opts.pageFooter) {
    const boxes = [];
    if (opts.pageFooter) {
      boxes.push(
        '@bottom-left { content: ' + cssString(opts.pageFooter) +
          '; font: 9pt system-ui, sans-serif; color: #555; }'
      );
    }
    if (opts.pageNumbers) {
      boxes.push(
        '@bottom-center { content: counter(page) " / " counter(pages); ' +
          'font: 9pt system-ui, sans-serif; color: #555; }'
      );
    }
    rules.push('@page { ' + boxes.join(' ') + ' }');
  }
  return rules.join('\n');
}

/**
 * Build the one document flow mode prints.
 *
 * The body goes into the clean template's empty `<main>`, and the flow CSS is
 * appended LAST so its break rules win over anything equal-specificity the
 * source carried (the template's own reset is added at build time too).
 * @param {string} templateHtml output of buildCleanTemplate (empty <main>)
 * @param {string} bodyHtml prelude + sections + footer, concatenated
 * @param {{pageNumbers?: boolean}} [opts]
 * @returns {string}
 */
export function buildFlowDocument(templateHtml, bodyHtml, opts = {}) {
  const style = '<style id="tympan-flow">\n' + flowCss({ pageNumbers: opts.pageNumbers, pageFooter: opts.pageFooter, fill: opts.fill }) + '\n</style>';
  let doc = templateHtml.replace('<main></main>', '<main>' + bodyHtml + '</main>');
  if (!doc.includes('</head>')) doc = doc + style;
  else doc = doc.replace('</head>', style + '</head>');
  // The flow print document must carry the SOURCE's own <html lang>: the
  // tagged writer derives /Lang from the print document, and its fallback
  // for a lang-less one is the AGENT'S locale (en-US on this machine), which
  // would make two identical inputs differ across machines. A missing
  // language is the source's gap — `tympan lint --a11y` names it — and
  // applyTaggedTail deletes the engine's fallback instead of inventing one.
  if (opts.lang) {
    doc = doc.replace(/<html\b(?![^>]*\blang\s*=)([^>]*)>/i, (m, attrs) => `<html${attrs} lang="${opts.lang}">`);
  }
  return doc;
}

/**
 * Print the whole flow document with exactly one `page.pdf()` call.
 * @param {import('playwright').Browser} browser
 * @param {string} docHtml
 * @param {string} outPath
 * @param {object} geo resolveGeometry() output
 * @param {object} [opts] { offline, allowNet, waitFor, waitTimeout, onProgress, scale }
 *   `scale` is 1 in every mode except opt-in `--fill tight`, where a bounded
 *   0.98/0.97 candidate may win (plan section 3.4; floor 0.97 by construction)
 * @returns {Promise<{overflowPx: number, widthPx: number}>} DOM overflow, in px
 */
export async function printFlow(browser, docHtml, outPath, geo, opts = {}) {
  // The viewport is the print column, so the DOM layout and the printed layout
  // have the same width: 1in = 96 CSS px and the page margin is in inches, so
  // a 698px column is measured at 698px. That is what makes the DOM overflow
  // check below meaningful for the printed sheet.
  const page = await browser.newPage({ viewport: { width: geo.contentW, height: 1200 } });
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
    if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: opts.waitTimeout ?? 10000 });
    // Same dimensional fix as printSection: a screen `min-height:100vh` cover
    // would lay out at the print viewport's vh (paper/scale — grows as scale
    // shrinks) and strand a nearly-empty sheet behind it. Made absolute to
    // the sheet's text-area height here, before the print; the count is
    // reported, never silent.
    const vhClamped = await page.evaluate(clampViewportSizedBlocksInPage, {
      targetPx: Math.round((geo.H_IN - geo.margins.top - geo.margins.bottom) * 96),
    });
    // Content wider than the column cannot be fragmented by Chromium — it is
    // clipped at the page edge. Measured here, where the layout width is known,
    // and reported by verification instead of discovered by eye.
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return {
        overflowPx: Math.max(0, Math.round(doc.scrollWidth - doc.clientWidth)),
        widthPx: Math.round(doc.clientWidth),
        // The document language is what /Lang on the tagged tail carries —
        // harvested where the DOM is already in hand, never re-opened later.
        lang: typeof doc.lang === 'string' ? doc.lang : null,
        // Counted here so verification can say how many keep-together blocks
        // existed even when it cannot say whether one was split.
        keepTogetherBlocks: document.querySelectorAll('figure,table,pre,blockquote,img,svg').length,
      };
    });
    await page.pdf({
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
      // 1 means "flow, never shrink": anything else would silently undo the
      // point of this mode. `--fill tight` is the opt-in exception, and it is
      // a bounded, reported candidate — never a silent open loop.
      scale: opts.scale && opts.scale >= 0.97 ? opts.scale : 1,
      // `tagged` is opt-in AND flow-only (see pipeline.js): with one print
      // per document the engine's own structure tree survives whole, which
      // is the only shape a merged document cannot have.
      tagged: opts.tagged === true,
      preferCSSPageSize: false,
    });
    overflow.vhClamped = vhClamped.clamped;
    if (opts.onProgress) opts.onProgress('flow-printed', { outPath, ...overflow });
    return overflow;
  } finally {
    await page.close();
  }
}

/* ------------------------------------------------------------------ *
 * PDF measurement (pdfjs) — what the sheet actually carries.
 * ------------------------------------------------------------------ */

let pdfjs = null;
function getPdfjs() {
  if (!pdfjs) {
    const require = createRequire(import.meta.url);
    const log = console.log;
    const warn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    } finally {
      console.log = log;
      console.warn = warn;
    }
  }
  return pdfjs;
}

/** Multiply two PDF matrices [a,b,c,d,e,f]. */
function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/** Bounding box of the unit square under a matrix (where an image lands). */
function unitBox(m) {
  const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const union = (a, b) =>
  a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b.slice();

const intersect = (a, b) => {
  const box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return box[2] > box[0] && box[3] > box[1] ? box : null;
};

const PT_PER_PX = 0.75; // 96 CSS px per inch, 72 pt per inch

/**
 * Read the produced PDF back and measure it.
 *
 * Fill comes from the union of text boxes and image placements INSIDE the
 * printable rect. Deliberately excluded: vector fills (a painted background),
 * which is what makes pixel-coverage metrics read 100% on an empty sheet, and
 * page-margin-box text (page numbers), which sits outside the text area by
 * design and would otherwise inflate every page.
 *
 * @param {string} file PDF written by Chromium
 * @param {object} geo resolveGeometry() output
 * @returns {Promise<object>} { pages: [...], medianTextHeight, pageCount }
 */
export async function analyzeFlowPdf(file, geo) {
  const lib = getPdfjs();
  const OPS = lib.OPS;
  const IMAGE_OPS = new Set(
    [
      'paintImageXObject',
      'paintInlineImageXObject',
      'paintImageMaskXObject',
      'paintImageMaskXObjectGroup',
      'paintImageXObjectGroup',
      'paintSolidColorImageMask',
    ]
      .map((name) => OPS[name])
      .filter((v) => typeof v === 'number')
  );
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await lib.getDocument({ data, useSystemFonts: true, disableFontFace: true, verbosity: 0 }).promise;
  const margins = geo.margins || {};
  const printablePt = [
    (margins.left || 0) * 72,
    (margins.bottom || 0) * 72,
    geo.W - (margins.right || 0) * 72,
    geo.H - (margins.top || 0) * 72,
  ];
  const out = [];
  const textHeights = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const text = await page.getTextContent();
      let fillBox = null;
      let allBox = null;
      let paths = 0;
      let images = 0;
      let lastItem = null;
      const words = [];
      for (const item of text.items) {
        if (!item.transform) continue;
        const str = String(item.str || '');
        if (!str.trim()) continue;
        const h = Number(item.height) || Math.abs(item.transform[3]) || 0;
        const w = Number(item.width) || 0;
        const box = [item.transform[4], item.transform[5], item.transform[4] + w, item.transform[5] + h];
        allBox = union(allBox, box);
        const visible = intersect(box, printablePt);
        if (visible) fillBox = union(fillBox, visible);
        if (h > 1) textHeights.push(h);
        if (!lastItem || item.transform[5] < lastItem.y) lastItem = { y: item.transform[5], h };
        words.push(str);
      }

      const opList = await page.getOperatorList();
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      const pageArea = viewport.width * viewport.height;
      let implausibleImages = 0;
      for (let k = 0; k < opList.fnArray.length; k++) {
        const fn = opList.fnArray[k];
        const args = opList.argsArray[k] || [];
        if (fn === OPS.save) stack.push(ctm);
        else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        else if (fn === OPS.transform) ctm = mul(ctm, args);
        else if (fn === OPS.paintFormXObjectBegin) {
          stack.push(ctm);
          if (Array.isArray(args[0]) && args[0].length === 6) ctm = mul(ctm, args[0]);
        } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        else if (IMAGE_OPS.has(fn)) {
          images++;
          const box = unitBox(ctm);
          // Chromium paints some internal rasters at enormous user-space
          // scales and relies on a clip path to make them visible (measured:
          // a 2391x685px image under a 2391x-685 matrix on an A4 sheet). Those
          // boxes would read as "covers the page" and inflate fill, so they
          // count as ink but not as geometry. A photo that really occupies the
          // sheet stays inside this sanity bound.
          const w = box[2] - box[0];
          const h = box[3] - box[1];
          const plausible =
            w > 0 &&
            h > 0 &&
            w * h <= pageArea * 4 &&
            box[0] > -viewport.width &&
            box[1] > -viewport.height &&
            box[2] < viewport.width * 2 &&
            box[3] < viewport.height * 2;
          if (!plausible) {
            implausibleImages++;
            continue;
          }
          const visible = intersect(box, printablePt);
          if (visible) fillBox = union(fillBox, visible);
        } else if (fn === OPS.constructPath) paths++;
      }

      // Clipping is judged on TEXT only. A text box outside the sheet is a
      // defect the reader sees (a cut-off word); an image that bleeds is often
      // the design, and Chromium's internal clipping makes the raw boxes
      // unreliable. Content wider than the column is caught separately, from
      // the DOM, where the layout width is known.
      const tol = 1.5; // pt
      const clipped = !!allBox && (
        allBox[0] < -tol ||
        allBox[1] < -tol ||
        allBox[2] > viewport.width + tol ||
        allBox[3] > viewport.height + tol
      );
      const contentHeightPx = fillBox ? Math.round((fillBox[3] - fillBox[1]) / PT_PER_PX) : 0;
      out.push({
        index: i,
        widthPt: viewport.width,
        heightPt: viewport.height,
        contentHeightPx,
        usableHeightPx: Math.round((geo.H_IN - (margins.top || 0) - (margins.bottom || 0)) * 96),
        clipped,
        blank: !fillBox && paths === 0 && images === 0,
        pathOps: paths,
        imageOps: images,
        // Images whose user-space box was too large to be real geometry (see
        // the sanity bound above). Reported so a surprising fill can be
        // explained instead of guessed at.
        implausibleImages,
        lastTextHeight: lastItem ? lastItem.h : 0,
        text: words.join(' ').replace(/\s+/g, ' '),
      });
    }
  } finally {
    await doc.destroy();
  }
  const sorted = [...textHeights].sort((a, b) => a - b);
  const medianTextHeight = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  return { pages: out, medianTextHeight, pageCount: out.length };
}

/**
 * Flow-mode verification: the invariants this mode can actually prove.
 *
 * Section mode asserts "pages === sections" and throws on a spill; flow mode
 * has no such equivalence, so it asserts the things that make a flowing print
 * trustworthy: it produced pages, no page is blank, nothing was clipped at the
 * page edge, nothing overflowed the column, and the probe still matches.
 * @param {object} analysis analyzeFlowPdf() result
 * @param {object} [opts] { probe, overflowPx, keepTogetherBlocks, scale }
 *   `scale` reports the opt-in `--fill tight` candidate that won (1 otherwise);
 *   it is carried, not assumed, so a silent open-loop shrink cannot appear
 * @returns {object}
 */
/**
 * Map every section to the sheet its heading landed on, from the PDF's own
 * text layer.
 *
 * This is what flow mode could NOT do before (`--outline` rejected) and what
 * the plan's section 3.5 asked for: auto bookmarks with real destinations.
 * The search is monotone (sections are printed in order), matches through
 * verify.js's whitespace-flexing semantics so a probe cannot pass in one
 * place and fail in another, and skips the first `offset` pages — the TOC's
 * own page contains every title and would match everything at once.
 *
 * @param {{pages: Array<{text: string}>}} analysis analyzeFlowPdf() output
 * @param {Array<{title?: string|null, id?: string}>} sections in print order
 * @param {{offset?: number}} [opts] sheets to skip (TOC pages already printed)
 * @returns {Array<number|null>} 1-based sheet per section, null when not found
 */
export function mapSectionsToPages(analysis, sections, opts = {}) {
  const pages = analysis.pages || [];
  const offset = Math.max(0, opts.offset || 0);
  // Tokens strip punctuation and case: printed text attaches "One." where the
  // detection lead says "One", and pdfjs may split either way.
  const normalizeToken = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const pageTokens = pages.map((p) =>
    String(p.text || '').split(/\s+/).map(normalizeToken).filter(Boolean)
  );
  const hasRun = (tokens, words) => {
    if (!tokens.length || words.some((w) => !w)) return false;
    for (let i = 0; i + words.length <= tokens.length; i++) {
      let ok = true;
      for (let j = 0; j < words.length; j++) {
        if (tokens[i + j] !== words[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  };
  let cursor = offset;
  return (sections || []).map((s) => {
    // Anchor preference without a printed TOC: the section's heading title
    // (kept by break-inside:avoid to exactly one sheet — a reliable anchor).
    // WITH a TOC: the lead, because in flow mode the TOC is a flowing block
    // that shares sheet 1 with real sections (the offset trick above assumes
    // one sheet per TOC page), and TOC ROWS themselves are made of titles —
    // so a title anchor matches every TOC row at once. Leads never appear in
    // a row, and a heading straddle is impossible anyway.
    const anchorSource =
      s && opts.preferLead && s.lead ? s.lead : s && (s.title || s.lead || s.id)
        ? (s.title || s.lead || s.id)
        : '';
    const anchor = String(anchorSource || '');
    const words = anchor.split(/\s+/).filter(Boolean).slice(0, 4).map(normalizeToken);
    if (!words.length) return null;
    // A print can end MID-LEAD (the heading stays on this sheet, its body
    // starts the next) — chip words off the anchor instead of failing it:
    // first 4 words, then 2, then 1. Degrading a heading-only anchor (the
    // normal case) never happens, because break-inside:avoid keeps a heading
    // whole on exactly one sheet.
    for (const n of [4, 2, 1]) {
      const probe = words.slice(0, n);
      if (!probe.length) continue;
      for (let i = cursor; i < pageTokens.length; i++) {
        if (hasRun(pageTokens[i], probe)) {
          cursor = i; // next section starts on this sheet or after
          return i + 1;
        }
      }
    }
    return null;
  });
}

/**
 * Resolve the outline entries flow mode writes: one per section, on the
 * page the mapping found, falling FORWARD (never backward) when a heading
 * could not be located — an outline entry that points one entry too late is
 * far less wrong than an outline that reverses order.
 * @param {Array<{title: string}>} titles in print order
 * @param {Array<number|null>} sheets mapSectionsToPages() output
 * @returns {Array<{title: string, page: number}>} 0-based page destinations
 */
export function flowOutlineEntries(titles, sheets) {
  const out = [];
  let last = 0;
  for (let i = 0; i < titles.length; i++) {
    const found = sheets[i];
    let page = found == null ? nextAvailable(out, i) : found - 1;
    if (page < last) page = last;
    last = page;
    out.push({ title: titles[i], page });
  }
  return out;
}

/** When a heading is not found, the fallback page is its run-order fallback. */
function nextAvailable(out, i) {
  const lastEntry = out[out.length - 1];
  return lastEntry ? Math.min(i, lastEntry.page + 1) : i;
}

export function verifyFlow(analysis, opts = {}) {
  const pages = analysis.pages || [];
  const blankPages = pages.filter((p) => p.blank).map((p) => p.index);
  const clippedPages = pages.filter((p) => p.clipped).map((p) => p.index);
  const overflowPx = Number(opts.overflowPx) || 0;
  const lastText = pages.length ? pages[pages.length - 1].text : '';
  // verify.js owns probe semantics (whitespace flexing, literal strings); both
  // modes match through it so a probe cannot pass in one and fail in the other.
  const probeOk = opts.probe == null ? null : probeRegex(opts.probe).test(lastText);
  const expected = opts.expectedPages ?? null;
  const pagesOk = expected == null ? pages.length > 0 : pages.length === expected;
  return {
    mode: 'flow',
    ok: pages.length > 0 && pagesOk && !blankPages.length && !clippedPages.length && overflowPx <= 0 && probeOk !== false,
    pages: pages.length,
    pagesOk,
    blankPages,
    clippedPages,
    overflowPx,
    scaleApplied: opts.scale && opts.scale >= 0.97 ? opts.scale : 1,
    fillPolicy: opts.fillPolicy ?? null,
    strandedHeadingPages: opts.strandedHeadingPages || [],
    // Not measurable from a flowing print: Chromium never tells us which  page
    // a DOM block landed on. Reported as unmeasured rather than assumed clean.
    keepTogether: { measured: false, blocks: opts.keepTogetherBlocks ?? null },
    probeOk,
    sizeBytes: opts.sizeBytes ?? null,
  };
}
