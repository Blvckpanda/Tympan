/**
 * finalize.js — the one place a PDF becomes deterministic and self-describing.
 *
 * Two very different producers feed this module:
 *
 *   section mode  prints one PDF per section and merges them with pdf-lib;
 *                 the merged document is finalised in memory.
 *   flow mode     prints the whole body once (Chromium paginates), then the
 *                 bytes on disk are loaded and finalised here.
 *
 * Both must carry identical metadata semantics or "same input, same bytes"
 * becomes a per-mode accident: fixed timestamps, a content-derived /ID, the
 * `tympan:<hash>` keyword, and the same Producer string. Keeping that in one
 * function is what makes the determinism test meaningful for both.
 *
 * The order of the calls below is load-bearing: pdf-lib serialises metadata in
 * the order the trailer/info object is built, so moving them changes output
 * bytes for every existing user.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFArray, PDFRef } from 'pdf-lib';

const require = createRequire(import.meta.url);
const { version: TYMPAN_VERSION } = require('../package.json');

/** Fixed metadata epoch: every output carries the same timestamps. */
export const FIXED_DATE = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

/** Producer string written into every PDF trailer. */
export const PRODUCER = `tympan ${TYMPAN_VERSION}`;

/**
 * The document /ID, derived from the input hash rather than from the output
 * bytes (which would be circular): identical input -> identical /ID, and two
 * different inputs never collide on the same id by accident.
 * @param {string} [contentHash]
 * @returns {import('pdf-lib').PDFHexString}
 */
function contentId(contentHash) {
  const idHex = crypto
    .createHash('sha256')
    .update('tympan-id\0' + (contentHash || PRODUCER))
    .digest('hex')
    .slice(0, 32);
  return PDFHexString.of(idHex);
}

/**
 * Apply the deterministic tail to a pdf-lib document, in the proven order.
 * @param {import('pdf-lib').PDFDocument} doc
 * @param {{contentHash?: string}} [opts]
 */
export function applyDeterministicMetadata(doc, opts = {}) {
  doc.setProducer(PRODUCER);
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  if (opts.contentHash) doc.setKeywords([`tympan:${opts.contentHash}`]);
  const id = contentId(opts.contentHash);
  doc.context.trailerInfo.ID = doc.context.obj([id, id]);
}

/**
 * Collapse byte-identical, same-filter raw streams.
 *
 * The merge path copies every section print's objects into one document, so
 * resources two sections happen to share (repeatable logos, identical image
 * XObjects, Chromium's own empty streams) arrive as SEPARATE indirect objects
 * with identical bytes. pdf-lib does not dedupe on copy; pdfjs renders the
 * dupes fine, but the file carries them forever.
 *
 * Measured honestly (plan section 2 expected font programs here): the 28
 * font-program copies in section-mode output are NOT byte-identical — each
 * melt of the same face carries a different glyph subset, so name-level
 * dedup would corrupt glyph maps and text extraction. What IS safe, and what
 * this does, is content-level dedup: only streams whose bytes AND filter
 * match exactly are collapsed, by redirecting every reference to the
 * canonical copy and dropping the dupes. Worth 1.3 KB on the measured deck
 * today — the byte win the plan promised (2.9x) came from printing the body
 * ONCE, which is what `--flow` does, measured there at 3.2x.
 *
 * Deterministic by construction: enumerateIndirectObjects is ref-number
 * sorted, first-seen wins, no randomness anywhere.
 *
 * @param {import('pdf-lib').PDFDocument} doc
 * @returns {{removed: number}} number of duplicated objects dropped
 */
export function dedupeIdenticalStreams(doc) {
  const ctx = doc.context;
  const canonical = new Map(); // content-hash + filter -> first ref
  const dupes = new Map(); // ref string -> canonical PDFRef
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const filter = obj.dict.get(PDFName.of('Filter'));
    const key =
      String(filter ? filter.toString() : '') + '\0' +
      crypto.createHash('sha256').update(obj.contents).digest('hex');
    if (canonical.has(key)) dupes.set(ref, canonical.get(key));
    else canonical.set(key, ref);
  }
  if (!dupes.size) return { removed: 0 };
  // Reference-find by STRING form ("12 0 R"), not identity: an embedded ref
  // can be an equal-value instance rather than the same object.
  const dupesByString = new Map();
  for (const [ref, canonicalRef] of dupes) dupesByString.set(String(ref), canonicalRef);
  // pdf-lib's PDFDict knows `.entries()`, PDFArray does not — arrays are
  // walked by index. Both are mutable in place, which is what makes
  // reference-rewriting possible without rebuilding the graph.
  const isDictLike = (o) => o && typeof o.entries === 'function' && typeof o.set === 'function';
  const isArrayLike = (o) => o instanceof PDFArray;
  const seen = new Set();
  const visit = (node) => {
    if (seen.has(node)) return;
    seen.add(node);
    if (isArrayLike(node)) {
      const n = node.size();
      for (let i = 0; i < n; i++) rewriteSlot(node, i, node.get(i));
    } else if (isDictLike(node)) {
      for (const [k, v] of node.entries()) rewriteSlot(node, k, v);
    }
  };
  const rewriteSlot = (container, key, v) => {
    if (v instanceof PDFRef) {
      const canonicalRef = dupesByString.get(String(v));
      if (canonicalRef && canonicalRef !== v) {
        container.set(key, canonicalRef);
      }
      return;
    }
    if (isArrayLike(v) || isDictLike(v)) visit(v);
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      // A stream's payload is never rewritten: only the dict that points at
      // other objects (ExtGState, resources chains) is walked.
      visit(obj.dict);
    } else {
      visit(obj);
    }
  }
  // The trailer can reference streams too (rare, but the root's metadata
  // holder is a stream) — same walk, same rules.
  if (ctx.trailerInfo) {
    for (const key of Object.keys(ctx.trailerInfo)) visit(ctx.trailerInfo[key]);
  }
  for (const ref of dupes.keys()) ctx.delete(ref);
  return { removed: dupes.size };
}

/**
 * Write a PDF outline (bookmarks panel), using low-level pdf-lib objects
 * (pdf-lib 1.x has no high-level outline API). Shared by BOTH producers:
 * section mode calls it during the merge, flow mode on the loaded print —
 * the difference is only where `page` comes from (section mode: one page per
 * entry; flow mode: the sheet the section's heading landed on, from the text
 * layer). Each entry targets the top of its page with a /Fit destination.
 * @param {import('pdf-lib').PDFDocument} doc
 * @param {import('pdf-lib').PDFPage[]} pages
 * @param {Array<{title: string, page?: number}>} entries (page 0-based, default i)
 */
export function writeOutline(doc, pages, entries) {
  const ctx = doc.context;
  const outlinesRef = ctx.nextRef();
  const pageRefs = pages.map((p) => p.ref || p.indirectReference);
  const itemRefs = entries.map(() => ctx.nextRef());
  entries.forEach((entry, i) => {
    const item = {
      Title: PDFHexString.fromText(entry.title),
      Parent: outlinesRef,
      Count: 0,
      Dest: [pageRefs[Math.min(entry.page ?? i, pageRefs.length - 1)], 'Fit'],
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
 * Finalise a PDF that was produced outside pdf-lib (a Chromium print) and
 * write it to `outputPath`.
 *
 * Chromium stamps its own Producer and two creation dates into every print, so
 * a flow-mode PDF that skipped this step would differ between two runs of the
 * same input. `updateMetadata: false` keeps pdf-lib from re-stamping, exactly
 * as the merge path already does. Outline entries arrive with an explicit
 * 0-based `page` (flow's mapping is not a bijection from pages); section mode
 * merges still write their own outline in `mergeCentered`.
 *
 * @param {string} inputPath PDF written by Chromium
 * @param {string} outputPath where the finalised PDF goes (may equal inputPath)
 * @param {object} [opts] { contentHash, title, author, subject, creator, outline? }
 * @returns {Promise<{bytes: number}>}
 */
export async function finalizePdf(inputPath, outputPath, opts = {}) {
  const doc = await PDFDocument.load(fs.readFileSync(inputPath));
  dedupeIdenticalStreams(doc);
  if (opts.creator) doc.setCreator(opts.creator);
  if (opts.title) doc.setTitle(opts.title);
  if (opts.author) doc.setAuthor(opts.author);
  if (opts.subject) doc.setSubject(opts.subject);
  applyDeterministicMetadata(doc, opts);
  if (Array.isArray(opts.outline) && opts.outline.length) {
    writeOutline(doc, doc.getPages(), opts.outline);
  }
  const bytes = await doc.save({ useObjectStreams: false, updateMetadata: false });
  fs.writeFileSync(outputPath, bytes);
  return { bytes: bytes.length };
}
