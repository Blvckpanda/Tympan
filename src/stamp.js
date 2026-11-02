/**
 * stamp.js — the watermark pass (SPEC §4 Phase 2: "watermark, stamping").
 *
 * A watermark is document SEMANTICS, not plumbing: unlike the minify pass
 * (which rewrites the file and may refuse), the stamp MUST be visible or the
 * conversion must fail. So there is no graceful refusal here — an input that
 * cannot be stamped throws, and the pipeline propagates it.
 *
 * Determinism rules the implementation, exactly like finalize.js:
 *   - the text is drawn once per page, same geometry everywhere;
 *   - the placement is a pure function of page size, text and the font's own
 *     advance widths (no dates, no random, no locale);
 *   - pdf-lib re-serializes the document it loaded, so the file bytes change
 *     by construction — but save({ updateMetadata: false }) keeps the
 *     finalize tail's metadata (Producer/dates/input-digest /ID) untouched,
 *     and useObjectStreams: false hands the minify pass the classic file
 *     form its positional scanner is proven on.
 */

import fs from 'node:fs';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

/** The stamp is dark grey at this alpha: visible on screen, faint on paper. */
export const STAMP_COLOR = rgb(0.5, 0.5, 0.5);
export const STAMP_OPACITY = 0.15;
/** Font size clamps: never unreadable, never wider than the diagonal allows. */
export const STAMP_MIN_SIZE = 12;
export const STAMP_MAX_SIZE = 96;
/** Share of the page diagonal the drawn line may occupy. */
export const STAMP_DIAGONAL_SHARE = 0.6;

/**
 * Where the text starts, given the page box, the text's advance width and
 * the chosen font size: the line runs bottom-left to top-right at 45
 * degrees (CCW is PDF-positive), with the line's MIDDLE pinned to the page
 * centre. Everything arrives precomputed so the arithmetic is testable.
 *
 * @param {{x: number, y: number}} center page centre (PDF box centre)
 * @param {number} textWidth advance width of the full string at `size`
 * @param {number} size font size used for the draw
 * @returns {{x: number, y: number, size: number, rotateDegrees: 45}}
 */
export function placementFor({ center, textWidth, size }) {
  const cos = Math.SQRT1_2; // cos(45) === sin(45) === sqrt(1/2)
  const half = (textWidth || 0) / 2;
  return {
    x: center.x - half * cos,
    y: center.y - half * cos,
    size,
    rotateDegrees: 45,
  };
}

/**
 * Choose the font size for a page and text: fill STAMP_DIAGONAL_SHARE of the
 * page diagonal, then clamp. Deterministic in page size + text alone.
 * @param {{width: number, height: number}} pageSize page MediaBox as width/height
 * @param {number} unitWidth advance width per point of size (from the font)
 * @returns {number} font size in points
 */
export function fontSizeFor({ width, height }, unitWidth) {
  if (!(unitWidth > 0)) return STAMP_MIN_SIZE;
  const diagonal = Math.sqrt(width * width + height * height);
  const target = diagonal * STAMP_DIAGONAL_SHARE;
  const targetWidth = target / unitWidth; // width at size 10 -> size
  return Math.min(STAMP_MAX_SIZE, Math.max(STAMP_MIN_SIZE, targetWidth));
}

/**
 * Stamp `text` across every page of the PDF at `file`, in place.
 *
 * @param {string} file absolute path of a produced PDF
 * @param {string} text required, non-empty; newlines are flattened to spaces
 * @returns {{pages: number, text: string}} what the report carries
 */
export async function stampPdf(file, text) {
  const content = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  if (!content) throw new Error('stamp: watermark text is required (non-empty)');
  const bytes = fs.readFileSync(file);
  let pdf;
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    throw new Error(`stamp: cannot load ${file} for stamping: ${(e && e.message) || e}`);
  }
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  // Advance width per point of size: font.widthOfTextAtSize is linear in
  // size for standard fonts, and a fixed 10-pt probe makes the unit exact.
  const unitWidth = font.widthOfTextAtSize(content, 10) / 10;
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const size = fontSizeFor({ width, height }, unitWidth);
    const textWidth = font.widthOfTextAtSize(content, size);
    const place = placementFor({ center: { x: width / 2, y: height / 2 }, textWidth, size });
    page.drawText(content, {
      x: place.x,
      y: place.y,
      size: place.size,
      rotate: degrees(place.rotateDegrees),
      font,
      color: STAMP_COLOR,
      opacity: STAMP_OPACITY,
    });
  }
  const saved = await pdf.save({ updateMetadata: false, useObjectStreams: false });
  fs.writeFileSync(file, saved);
  return { pages: pdf.getPageCount(), text: content };
}
