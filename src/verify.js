/**
 * verify.js — self-verification of converted outputs.
 *
 * Checks, per output file:
 *   - page count === detected section count (one section per page)
 *   - optional text probe (options.probe: string|RegExp) against the LAST
 *     page's extracted text
 * Spill pages are enforced earlier (runPassFull throws), so a green
 * verification plus that guard covers the proven acceptance checks.
 */
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { createRequire } from 'node:module';

// pdfjs-dist must stay pinned at 3.11.174: newer releases throw
// `hashOriginal.toHex is not a function` during text extraction. The legacy
// build is loaded through createRequire (bypasses subpath exports) and lazily
// so CLI paths that never verify don't pay for it or print canvas polyfill
// warnings.
let pdfjs = null;
function getPdfjs() {
  if (!pdfjs) {
    const require = createRequire(import.meta.url);
    // pdfjs prints its own "Cannot polyfill DOMMatrix/Path2D" warnings at
    // module load under Node (no canvas package). They are noise for users —
    // silence only around the require, restore immediately after.
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

async function lastPageText(file) {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await getPdfjs().getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  const page = await doc.getPage(doc.numPages);
  const tc = await page.getTextContent();
  return tc.items.map((t) => t.str).join(' ');
}

/**
 * Verify converted outputs.
 * @param {object} result { master, email?, detection }
 * @param {object} [options] { probe?: string|RegExp }
 * @returns {Promise<object>} { ok, sectionCount, outputs[] }
 */
export async function verifyOutputs(result, options = {}) {
  // Teaser runs produce fewer pages than detected sections; callers pass the
  // converted count explicitly via options.expectedPages.
  const expected = options.expectedPages ?? result.detection.sections.length;
  const outputs = [];
  for (const file of [result.master, result.email].filter(Boolean)) {
    const pages = (await PDFDocument.load(fs.readFileSync(file))).getPageCount();
    const text = await lastPageText(file);
    const probeOk = options.probe == null ? null : Boolean(text.match(options.probe));
    outputs.push({
      file,
      pages,
      expected,
      pagesOk: pages === expected,
      probeOk,
      sizeBytes: fs.statSync(file).size,
    });
  }
  return {
    ok: outputs.every((o) => o.pagesOk && o.probeOk !== false),
    sectionCount: expected,
    outputs,
  };
}
