/**
 * split.js — splitting a produced PDF into per-sheet artifacts (SPEC §4
 * Phase 2: "merge/split/compose"; merge, TOC and page furniture shipped in
 * the 0.8 line, split is this file).
 *
 * The composition rule the pipeline actually runs: stamp (semantics) ->
 * minify (size) -> split READS the finished master, so every artifact a
 * reader receives carries exactly what the master carries. Splitting copies
 * pages with pdf-lib's copyPages — each part gets the page's own shared
 * resources copied in, byte-preserved, so a part renders and extracts on
 * its own without consulting the master again.
 *
 * Determinism, same standard as finalize.js: parts are built in page order
 * from the same bytes, and each carries the deterministic metadata tail
 * (fixed dates, same Producer, no dates of its own invention).
 */

import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { applyDeterministicMetadata } from './finalize.js';

/**
 * Read a document info text field without failing on an absent one —
 * pdf-lib's getters throw for missing fields, and a part must not inherit a
 * lie-shaped empty string.
 * @param {import('pdf-lib').PDFDocument} src
 * @param {(doc: import('pdf-lib').PDFDocument) => string | undefined} get
 * @returns {string | undefined}
 */
function infoField(src, get) {
  try {
    return get(src);
  } catch {
    return undefined;
  }
}

/**
 * @param {string} file absolute path of the produced master PDF
 * @param {{dir?: string}} [opts] where to write the parts (default: beside
 *   the master)
 * @returns {Promise<{parts: number, files: string[]}>} part paths in page
 *   order; file N is page N
 */
export async function splitPdf(file, opts = {}) {
  const bytes = fs.readFileSync(file);
  let src;
  try {
    src = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    throw new Error(`split: cannot load ${file}: ${(e && e.message) || e}`);
  }
  const total = src.getPageCount();
  if (total < 1) throw new Error('split: the produced document has no pages to split');
  const dir = opts.dir || path.dirname(file);
  const stem = path.basename(file).replace(/\.pdf$/i, '');
  const pad = String(total).length;
  // Self-describing parts: they inherit the document's own info fields and
  // then take the deterministic tail (fixed dates, same Producer). One
  // load of the source matters not for bytes but for the fields.
  const title = infoField(src, (d) => d.getTitle());
  const author = infoField(src, (d) => d.getAuthor());
  const subject = infoField(src, (d) => d.getSubject());
  const creator = infoField(src, (d) => d.getCreator());
  const files = [];
  for (let i = 1; i <= total; i++) {
    const part = await PDFDocument.create();
    if (title) part.setTitle(title);
    if (author) part.setAuthor(author);
    if (subject) part.setSubject(subject);
    if (creator) part.setCreator(creator);
    applyDeterministicMetadata(part);
    const [copied] = await part.copyPages(src, [i - 1]);
    part.addPage(copied);
    const saved = await part.save({ updateMetadata: false, useObjectStreams: false });
    const partPath = path.join(dir, `${stem}-p${String(i).padStart(pad, '0')}.pdf`);
    fs.writeFileSync(partPath, saved);
    files.push(partPath);
  }
  return { parts: total, files };
}
