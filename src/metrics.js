import { flowOutput } from './lint.js';

/**
 * metrics.js — page-quality math: how full is each page, and what got stranded.
 *
 * Measurements come from the DOM, never from the rasterized PDF. The browser
 * knows every block's height to sub-pixel precision before the print starts,
 * while "ink coverage" read off a rendered page lies the moment a document
 * paints a background: a full-bleed sheet measures as 100% covered while
 * carrying a single paragraph. That exact reading, taken on a real Kitch
 * deliverable on 2026-10-16, is why this module exists — it reported a
 * four-page document as zero waste.
 *
 * Everything here is pure and I/O-free, so the contract is unit-tested
 * without Chromium: the pipeline measures, this module judges, report.js
 * serializes, `tympan lint` explains.
 *
 * All heights are CSS pixels (96/inch), the unit the DOM reports and the unit
 * spill.test.mjs already uses to reason about the usable text area.
 */

/**
 * Share of the usable text area a page should carry before it is flagged.
 * Not a hard limit: a cover, a statement band or a full-bleed figure is
 * legitimately sparse, so callers may exempt pages and `tympan lint` reports
 * the finding rather than failing on it by default.
 */
export const TARGET_FILL = 0.7;

/** Clamp a DOM measurement to a finite, non-negative number. */
function num(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Round for stable JSON and stable test expectations (3 decimals). */
function round3(n) {
  return Math.round(num(n) * 1000) / 1000;
}

/**
 * Content height as a share of the usable text area.
 * A page with no usable area reports 0 — never NaN or Infinity, because this
 * value is printed in reports and compared in CI.
 * @param {number} contentHeightPx
 * @param {number} usableHeightPx
 * @returns {number} 0..1
 */
export function fillRatio(contentHeightPx, usableHeightPx) {
  const usable = num(usableHeightPx);
  if (usable <= 0) return 0;
  return Math.min(1, Math.max(0, num(contentHeightPx) / usable));
}

/**
 * Height left blank at the bottom of the page, in px.
 * Clamped at 0: a section taller than the text area has no blank tail, it has
 * an overflow problem (reported through `scaleApplied` and the spill guard).
 * @param {number} contentHeightPx
 * @param {number} usableHeightPx
 * @returns {number}
 */
export function blankTailPx(contentHeightPx, usableHeightPx) {
  return Math.max(0, num(usableHeightPx) - num(contentHeightPx));
}

/**
 * Normalise a block kind. Report consumers switch on these values, so junk
 * must not travel through as if it were a kind (and must not read as a
 * stranded heading).
 * @param {unknown} kind
 * @returns {'heading'|'text'|'figure'|'table'|null}
 */
export function normalizeBlockKind(kind) {
  const k = String(kind == null ? '' : kind).toLowerCase();
  return k === 'heading' || k === 'text' || k === 'figure' || k === 'table' ? k : null;
}

/**
 * Judge one page from its raw measurements.
 *
 * @param {object} page
 *   index?: number          1-based page number in the final PDF
 *   sectionId?: string|null the detected section this page came from
 *   contentHeightPx: number the measured height of the printed content
 *   usableHeightPx: number  the text area (page height minus margins)
 *   scaleApplied?: number   shrink factor used (1 when nothing shrank)
 *   lastBlockKind?: string  kind of the last block on the page ('heading',
 *                           'text', 'figure', 'table', …)
 *   keptTogether?: boolean  false when a `break-inside: avoid` block split
 * @param {object} [options] { targetFill, layout }
 * @returns {object} judged page record
 */
export function judgePage(page = {}, options = {}) {
  const targetFill = options.targetFill ?? TARGET_FILL;
  const fill = fillRatio(page.contentHeightPx, page.usableHeightPx);
  const scaleApplied = page.scaleApplied == null ? 1 : round3(page.scaleApplied);
  // The shrink the WIDTH bound alone required (1 when the content already fit
  // the column). Two different causes hide behind one scale factor, and they
  // want opposite fixes: a tall section needs a smaller type or more pages, a
  // document laid out wider than its own text column needs `contentWidth` or a
  // wider sheet. Reporting them as one number turned a single document-wide
  // mismatch into nine per-page "shrunk to fit" warnings on the Kitch deck
  // (measured 2026-10-16: 774px layout, 698px column, every page at 0.902).
  const widthScale = page.widthScale == null ? 1 : round3(page.widthScale);
  // `width` only when the width bound ALONE accounts for the scale (the two
  // numbers agree); anything smaller than the width bound was the height.
  const scaledFor = scaleApplied >= 0.999
    ? 'none'
    : widthScale < 1 && Math.abs(scaleApplied - widthScale) <= 0.005
      ? 'width'
      : 'height';
  return {
    index: page.index ?? null,
    sectionId: page.sectionId ?? null,
    contentHeightPx: Math.round(num(page.contentHeightPx)),
    usableHeightPx: Math.round(num(page.usableHeightPx)),
    blankTailPx: Math.round(blankTailPx(page.contentHeightPx, page.usableHeightPx)),
    fillRatio: round3(fill),
    scaleApplied,
    /** Shrink the width bound alone required (1 when the content fit). */
    widthScale,
    /** Why the page shrank: 'height' | 'width' | 'none'. */
    scaledFor,
    /**
     * The 0.7 judgement is SECTION-mode: flow's pages share sheets, so "under
     * 70%" is not a question the mode can answer. A caller that knows the run
     * is flow passes `layout: 'flow'` and flow pages carry null (unjudged in
     * this mode, the same tri-state as `keptTogether`); every caller that does
     * not know keeps the boolean, unchanged.
     */
    underfilled: options.layout === 'flow' ? null : fill < targetFill,
    // Kind of the last block on the page, normalised and carried through:
    // without this the report loses WHY a page was flagged.
    lastBlockKind: normalizeBlockKind(page.lastBlockKind),
    // A heading as the last block on a sheet strands its own section: the
    // reader turns the page to find the content it introduces.
    strandedHeading: normalizeBlockKind(page.lastBlockKind) === 'heading',
    // A split `break-inside: avoid` block is reported, never silently traded
    // away — the gap it would have cost is the caller's decision to make.
    // Tri-state on purpose: section mode can prove it (one section, one page),
    // flow mode cannot (Chromium does not map a block to a page), and
    // `null` means UNMEASURED — never the same thing as "true".
    keptTogether: page.keptTogether === false ? false : page.keptTogether === true ? true : null,
  };
}

/**
 * Document-level rollup over raw page measurements.
 * @param {Array<object>} pages raw measurements (judgePage shape)
 * @param {object} [options] { targetFill, layout }
 * @returns {{pages: number, targetFill: number, meanFill: number,
 *   minFill: number, underfilledPages: number[], strandedHeadings: number[],
 *   splitKeepTogether: number[], shrunkPages: number[], overflowPages: number[]}}
 */
export function summarizeQuality(pages, options = {}) {
  const targetFill = options.targetFill ?? TARGET_FILL;
  // The gate must be known BEFORE judging: judgePage drops the section-only
  // 0.7 judgement field for flow records (null), so the rollup and the very
  // records it is built from judge in the SAME mode. Explicit `layout` wins;
  // `measuredFrom: 'pdf'` on a page infers — the fallback a caller that truly
  // does not know still gets.
  const flow = flowOutput({ layout: options.layout, pages });
  const judged = (pages || []).map((p) => judgePage(p, { targetFill, layout: flow ? 'flow' : options.layout }));
  const fills = judged.map((p) => p.fillRatio);
  const mean = fills.length ? fills.reduce((a, b) => a + b, 0) / fills.length : 0;
  return {
    pages: judged.length,
    targetFill,
    meanFill: round3(mean),
    minFill: fills.length ? round3(Math.min(...fills)) : 0,
    // Section judgement only: suppressed for flow, where the flow rules own
    // the fill question (and where `targetFill` is not the ruler either way).
    underfilledPages: flow ? [] : judged.filter((p) => p.underfilled).map((p) => p.index),
    strandedHeadings: judged.filter((p) => p.strandedHeading).map((p) => p.index),
    splitKeepTogether: judged.filter((p) => p.keptTogether === false).map((p) => p.index),
    // Shrunk BECAUSE the section was too tall — the case that makes type size
    // vary between pages of one document.
    shrunkPages: judged.filter((p) => p.scaledFor === 'height').map((p) => p.index),
    // Shrunk because the content is wider than the column: reported separately
    // so it can be explained once (the document is laid out too wide) instead
    // of repeated for every page it touches.
    overflowPages: judged.filter((p) => p.scaledFor === 'width').map((p) => p.index),
  };
}

/**
 * One human-readable line for the CLI and doctor-style output.
 * Reports only what is wrong: a clean document gets the fill numbers alone.
 * @param {object} summary summarizeQuality() result
 * @returns {string}
 */
export function formatQualityLine(summary) {
  const pct = (n) => `${Math.round(num(n) * 100)}%`;
  const bits = [`fill: mean ${pct(summary.meanFill)}, min ${pct(summary.minFill)}`];
  if (summary.underfilledPages.length) {
    bits.push(`${summary.underfilledPages.length} page(s) under ${pct(summary.targetFill)}`);
  }
  if (summary.strandedHeadings.length) {
    bits.push(`${summary.strandedHeadings.length} stranded heading(s)`);
  }
  if (summary.splitKeepTogether.length) {
    bits.push(`${summary.splitKeepTogether.length} split keep-together block(s)`);
  }
  if (summary.shrunkPages.length) {
    bits.push(`${summary.shrunkPages.length} page(s) shrunk to fit`);
  }
  if (summary.overflowPages && summary.overflowPages.length) {
    bits.push(`${summary.overflowPages.length} page(s) wider than the column`);
  }
  return bits.join('; ');
}
