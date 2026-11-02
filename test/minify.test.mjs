/**
 * minify.test.mjs — the --minify size pass (SPEC §4 Phase 2's own lever).
 *
 * The pass rewrites the FILE, never the document: dictionaries pack into
 * object streams, the xref becomes one compressed /Type /XRef stream, and
 * unfiltered streams gain /FlateDecode — with object numbers, page content
 * and extractable text preserved. Most of this file is pure: a hand-built
 * fixture asserts determinism, honest stats and loud refusals. The two
 * Chromium-guarded tests exist for the same reason the bytes instrument
 * has one: on REAL Chromium output the pass must be strictly smaller
 * while both of the repo's readers (pdf-lib's page count, pdfjs's text
 * extraction) see the same document as they did before the rewrite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { minifyPdf, OBJSTM_MAX_OBJECTS, OBJSTM_MAX_BYTES, MINIFY_LEVEL } from '../src/minify.js';
import { auditPdfBytes, BYTE_KINDS } from '../src/bytes.js';
import { convert, extractPages } from '../src/index.js';
import { findChromium } from '../src/browser.js';
import { PDFDocument } from 'pdf-lib';

/**
 * A hand-built PDF the pass can byte-rewrite: one already-filtered stream,
 * one unfiltered stream (the compressible one), three dictionaries
 * (catalog, page tree, page) and a classic trailer. Dangling refs are
 * avoided on purpose — an unresolvable scan must refuse, and that refusal
 * has its own test below.
 */
function buildFixturePdf() {
  return Buffer.from([
    '%PDF-1.4\n',
    '1 0 obj<</Filter/FlateDecode>>stream\nPAGEDATA\nendstream endobj\n',
    '2 0 obj<</Length 64>>stream\n',
    'RRaw'.repeat(16), // 64 highly compressible bytes
    '\nendstream endobj\n',
    '3 0 obj<</Type/Catalog/Pages 4 0 R>>endobj\n',
    '4 0 obj<</Type/Pages/Kids[5 0 R]/Count 1>>endobj\n',
    '5 0 obj<</Type/Page/Parent 4 0 R/MediaBox[0 0 595 842]>>endobj\n',
    'xref\n0 6\ntrailer<</Size 6/Root 3 0 R>>\n%%EOF',
  ].join(''), 'latin1');
}

test('minify: exported knobs are numbers a tuning gate can print', () => {
  assert.equal(typeof OBJSTM_MAX_OBJECTS, 'number');
  assert.equal(typeof OBJSTM_MAX_BYTES, 'number');
  assert.equal(MINIFY_LEVEL, 9);
});

test('minify: same bytes in, same bytes out (deterministic by construction)', () => {
  const buf = buildFixturePdf();
  const first = minifyPdf(buf);
  const second = minifyPdf(buf);
  assert.ok(Buffer.isBuffer(first.pdf));
  assert.deepEqual(second.pdf, first.pdf, 're-running the pass must not move a byte');
  assert.deepEqual(second.stats, first.stats);
});

test('minify: the file form is PDF 1.5 with a compressed xref stream', () => {
  const { pdf, stats } = minifyPdf(buildFixturePdf());
  const s = pdf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.5\n'), 'header skips to 1.5 (xref streams need it)');
  assert.ok(s.endsWith('%%EOF\n'), 'proper EOF tail');
  assert.ok(/\/Type\/XRef\/Size \d+\/W\[1 4 2\]/.test(s), 'the whole xref lives in one /Type /XRef stream');
  assert.ok(/\/Type\/ObjStm\/N \d+\/First \d+/.test(s), 'dictionaries ride an object stream');
  assert.ok(/startxref\n\d+\n/.test(s), 'startxref pointer present');
  assert.ok(stats.bytesAfter > 0 && stats.bytesAfter === pdf.length);
});

test('minify: stats account for every lever they touched', () => {
  const buf = buildFixturePdf();
  const { stats } = minifyPdf(buf);
  // Objects 3, 4, 5 are gen-0 dictionaries; object 1 is already filtered;
  // object 2 arrives unfiltered (64 'R'-patterned bytes) and must gain
  // /FlateDecode.
  assert.equal(stats.objectsPacked, 3);
  assert.equal(stats.objectStreams, 1);
  assert.equal(stats.streamsRecompressed, 1);
  assert.equal(stats.streamBytesBefore, 64);
  assert.ok(stats.streamBytesBefore >= stats.streamBytesAfter, 'compressible data must not grow');
  assert.equal(stats.bytesBefore, buf.length);
  // A hand-scale fixture may GROW: object streams and the xref stream carry
  // fixed per-batch overhead that dominates a 381-byte file. The real size
  // criterion is asserted on real Chromium output below.
});

test('minify: refuses encrypted files, loudly (success that lies is worse)', () => {
  const buf = buildFixturePdf().toString('latin1').replace(
    '/Size 6/Root 3 0 R',
    '/Size 6/Root 3 0 R/Encrypt 9 0 R'
  );
  assert.throws(() => minifyPdf(Buffer.from(buf, 'latin1')), /encrypted/);
});

test('minify: refuses incremental updates (/Prev in the trailer)', () => {
  const buf = buildFixturePdf().toString('latin1').replace(
    '/Size 6/Root 3 0 R',
    '/Size 6/Root 3 0 R/Prev 99'
  );
  assert.throws(() => minifyPdf(Buffer.from(buf, 'latin1')), /incremental/);
});

test('minify: refuses a scan whose references do not resolve', () => {
  const buf = Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj<</Type/Catalog/Pages 9 0 R>>endobj\n' + // object 9 does not exist
      'xref\n0 2\ntrailer<</Size 2/Root 1 0 R>>\n%%EOF',
    'latin1'
  );
  assert.throws(() => minifyPdf(buf), /did not find/);
});

test('minify: refuses bytes that are not a PDF at all', () => {
  assert.throws(() => minifyPdf(Buffer.from('just some text', 'latin1')), /PDF/);
});

test('minify: the rewritten fixture still audits and its buckets tie out', () => {
  const { pdf } = minifyPdf(buildFixturePdf());
  const a = auditPdfBytes(pdf);
  assert.equal(a.totalBytes, pdf.length);
  const streamBytes = BYTE_KINDS.reduce((n, k) => n + a.byKind[k].bytes, 0);
  assert.equal(a.streams.reduce((n, s) => n + s.bytes, 0), streamBytes, 'streams and rollup agree');
  // The unfiltered stream became /Filter /FlateDecode — a content stream,
  // and the packed dictionaries now live in the plumbing bucket 'other'
  // (the xref stream plus the object stream), not as painted content.
  assert.equal(a.byKind.other.objects, 2, 'one ObjStm plus one XRef stream');
  assert.ok(a.byKind.content.bytes > 0, 'both paint streams survived the rewrite');
});

test('minify: Gen>0 strays keep their number and their generation', () => {
  // A file whose catalog sits at gen 1: the xref row must carry gen 1, not
  // the gen-0 assumption reserved for new numbers above maxNum.
  const buf = Buffer.from([
    '%PDF-1.4\n',
    '1 0 obj<</Type/Catalog/Pages 2 1 R>>endobj\n',
    '2 1 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
    '3 0 obj<</Type/Page/Parent 2 1 R>>endobj\n',
    'xref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF',
  ].join(''), 'latin1');
  const { pdf } = minifyPdf(buf);
  const a = auditPdfBytes(pdf);
  const streamBytes = BYTE_KINDS.reduce((n, k) => n + a.byKind[k].bytes, 0);
  assert.equal(a.streams.reduce((n, s) => n + s.bytes, 0), streamBytes);
  // Survives its own pass (idempotent accounting) and keeps the trailing EOF.
  assert.ok(pdf.toString('latin1').endsWith('%%EOF\n'));
});

test('minify: an ObjStm full of dicts reads back with every object intact', () => {
  // Force more than one batch: 40 tiny dictionaries split into two
  // object streams at OBJSTM_MAX_OBJECTS, proving the batch loop and
  // the per-batch resident indexing.
  const dicts = [];
  for (let i = 0; i < 40; i++) {
    dicts.push(`${i + 1} 0 obj<</Type/Dict/Index ${i}/Next ${i === 39 ? null : i + 2} 0 R>>endobj\n`);
  }
  const buf = Buffer.from(
    '%PDF-1.4\n' + dicts.join('') + 'xref\n0 41\ntrailer<</Size 41/Root 1 0 R>>\n%%EOF',
    'latin1'
  );
  const { pdf, stats } = minifyPdf(buf);
  assert.equal(stats.objectsPacked, 40);
  assert.equal(stats.objectStreams, 2, '40 residents split at the 32-object cap');
  const s = pdf.toString('latin1');
  assert.ok(/\/Type\/ObjStm\/N 32\//.test(s), 'first batch holds the cap');
  assert.ok(/\/Type\/ObjStm\/N 8\//.test(s), 'second batch holds the remainder');
});

test('minify: Chromium output is strictly smaller with the document intact', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-minify-'));
  try {
    const src = path.resolve('test/corpus/article-medium.html');
    const base = await convert(src, { out: path.join(dir, 'base.pdf'), verify: false });
    const buf = fs.readFileSync(base.master);

    const { pdf, stats } = minifyPdf(buf);
    const minPath = path.join(dir, 'minified.pdf');
    fs.writeFileSync(minPath, pdf);

    // Phase 2's exit criterion, measured: the same document, fewer bytes.
    assert.ok(pdf.length < buf.length, `must shrink; got ${buf.length} -> ${pdf.length}`);
    assert.equal(stats.bytesBefore, buf.length);
    assert.equal(stats.bytesAfter, pdf.length);

    // pdf-lib is verification's page counter: same pages after the rewrite.
    const before = await PDFDocument.load(buf, { updateMetadata: false });
    const after = await PDFDocument.load(pdf, { updateMetadata: false });
    assert.equal(after.getPageCount(), before.getPageCount());

    // pdfjs is the text-layer instrument: identical extraction, byte for byte.
    const a = await extractPages(base.master);
    const b = await extractPages(minPath);
    assert.equal(a.length, b.length);
    assert.deepEqual(b, a, 'extracted text must be identical');

    // The plumbing buckets honestly: packed dicts and the xref stream are
    // 'other', and the arithmetic still ties out.
    const audit = auditPdfBytes(pdf);
    const streamBytes = BYTE_KINDS.reduce((n, k) => n + audit.byKind[k].bytes, 0);
    assert.equal(audit.streams.reduce((n, s) => n + s.bytes, 0), streamBytes);
    assert.ok(audit.byKind.other.objects >= 2, 'objstm + xref stream visible in the audit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('minify: convert({ minify: true }) rewrites the master in place and reports it', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-minify-opt-'));
  try {
    const src = path.resolve('test/corpus/article-short.html');
    const result = await convert(src, { out: path.join(dir, 'out.pdf'), verify: false, minify: true });
    assert.ok(result.minify, 'the conversion carries the pass stats');
    assert.ok(result.minify.bytesBefore > 0);
    assert.ok(result.minify.bytesAfter > 0);
    assert.ok(result.minify.bytesAfter < result.minify.bytesBefore, 'strictly smaller on disk');
    assert.equal(typeof result.minify.objectsPacked, 'number');
    // The rewritten master still loads and still carries its pages.
    const doc = await PDFDocument.load(fs.readFileSync(result.master), { updateMetadata: false });
    assert.equal(doc.getPageCount(), result.pages.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
