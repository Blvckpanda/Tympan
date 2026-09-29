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
  // Extraction whitespace is unstable: pdfjs splits words into separate text
  // items and Chromium letter-spacing widens the gaps, so "solo developer"
  // can come back as "solo   developer". Collapse runs to single spaces;
  // probeRegex() adds matching flexibility on the pattern side.
  return tc.items.map((t) => t.str).join(' ').replace(/\s+/g, ' ');
}

/**
 * Build the probe matcher. Probes are content contracts, not layout
 * assertions, so they are case-insensitive and whitespace-flexible:
 * every space in the pattern matches any whitespace run in the extracted
 * text (observed: pdfjs item joins put 1-3 spaces between words of the
 * same sentence). A string probe is matched literally (metacharacters
 * escaped) — it is text to find, not a pattern to compile; pass a RegExp
 * explicitly when regex semantics are wanted (its literal spaces are
 * flexed the same way, everything else is yours).
 * @param {string|RegExp} probe
 * @returns {RegExp}
 */
export function probeRegex(probe) {
  if (probe instanceof RegExp) {
    // Flex literal spaces, but not ones followed by a quantifier — a space
    // before `{2}`/`*`/`+`/`?` is the quantified atom itself (flexing there
    // produces `\\s+{2}`, "nothing to repeat").
    const src = probe.source.replace(/ (?![*+?{])/g, '\\s+');
    const flags = probe.flags.includes('i') ? probe.flags : probe.flags + 'i';
    return new RegExp(src, flags);
  }
  const escaped = String(probe).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(escaped, 'i');
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
    const probeOk = options.probe == null ? null : probeRegex(options.probe).test(text);
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
