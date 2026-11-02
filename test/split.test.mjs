/**
 * split.test.mjs — splitting a produced PDF into per-sheet artifacts
 * (SPEC §4 Phase 2's merge/split item; merge shipped in the 0.8 line).
 *
 * What a reader checks: there is one artifact per sheet, each renders and
 * extracts on its own carrying ONLY its own page, the naming is stable, and
 * the same master splits to the same bytes. The pipeline order (stamp ->
 * minify -> split) is pinned by the composition test: parts must survive
 * the minify pass that ran before them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitPdf } from '../src/split.js';
import { convert, extractPages } from '../src/index.js';
import { findChromium } from '../src/browser.js';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * A three-page, text-bearing fixture — the SAME buffer for every call so
 * determinism tests compare the pass, not the builder.
 */
async function buildThreePageFixture() {
  const pdf = await PDFDocument.create();
  pdf.setProducer('tympan split fixture');
  pdf.setTitle('tympan split fixture doc');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const page = pdf.addPage([595, 842]);
    page.drawText(`Fixture page ${i}: the body of a real letter`, {
      x: 72,
      y: 770,
      size: 14,
      font,
      color: rgb(0, 0, 0),
    });
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

/** Where each part's text should land, as a predicate over extracts. */
async function partTexts(master) {
  const { files } = await splitPdf(master);
  const texts = [];
  for (const f of files) {
    const pages = await extractPages(f);
    assert.equal(pages.length, 1, `a part must hold exactly one page: ${path.basename(f)}`);
    texts.push(pages[0]);
  }
  return { texts, files };
}

test('split: one artifact per page, in order, named beside the master', async () => {
  const fixture = await buildThreePageFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-split-parts-'));
  try {
    const master = path.join(dir, 'book.pdf');
    fs.writeFileSync(master, fixture);
    const { parts, files } = await splitPdf(master);
    assert.equal(parts, 3);
    assert.equal(files.length, 3);
    assert.deepEqual(files.map((f) => path.basename(f)), ['book-p1.pdf', 'book-p2.pdf', 'book-p3.pdf']);
    const texts = (await partTexts(master)).texts;
    // Each part carries ONLY its own page: the extraction of part N reads
    // "Fixture page N" and never "Fixture page (N+1)".
    for (let i = 0; i < 3; i++) {
      assert.ok(texts[i].includes(`Fixture page ${i + 1}`), `part ${i + 1} must carry its page`);
      assert.ok(!texts[i].includes(`Fixture page ${i + 2}`), `part ${i + 1} must NOT carry the next page`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('split: same master, same parts, same bytes (deterministic by construction)', async () => {
  const fixture = await buildThreePageFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-split-det-'));
  try {
    const a = path.join(dir, 'doc.pdf');
    fs.writeFileSync(a, fixture);
    const dir2 = path.join(dir, 'second');
    fs.mkdirSync(dir2);
    const b = path.join(dir2, 'doc.pdf');
    fs.writeFileSync(b, fixture);
    const first = await splitPdf(a);
    const second = await splitPdf(b);
    assert.equal(first.files.length, second.files.length);
    for (let i = 0; i < first.files.length; i++) {
      assert.deepEqual(
        fs.readFileSync(second.files[i]),
        fs.readFileSync(first.files[i]),
        `part ${i + 1} must not move a byte on re-splitting the same master`
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('split: parts inherit the document info and the deterministic tail', async () => {
  const fixture = await buildThreePageFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-split-meta-'));
  try {
    const master = path.join(dir, 'doc.pdf');
    fs.writeFileSync(master, fixture);
    const { files } = await splitPdf(master);
    const part = await PDFDocument.load(fs.readFileSync(files[0]), { updateMetadata: false });
    assert.equal(part.getTitle(), 'tympan split fixture doc', 'a part inherits the document title');
    // The deterministic tail, from finalize.js: fixed epoch dates, same Producer.
    assert.equal(new Date(part.getCreationDate()).toISOString(), new Date(Date.UTC(2000, 0, 1)).toISOString());
    assert.ok(part.getProducer().startsWith('tympan '), `Producer should be tympan's, got ${part.getProducer()}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('split: refuses non-PDF bytes and page-less documents, loudly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-split-refuse-'));
  try {
    const junk = path.join(dir, 'junk.pdf');
    fs.writeFileSync(junk, 'not a pdf at all');
    await assert.rejects(splitPdf(junk), /cannot load/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('split: convert({ split }) writes one part per page and reports them', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-split-e2e-'));
  try {
    const src = path.resolve('test/corpus/article-short.html');
    const result = await convert(src, { out: path.join(dir, 'out.pdf'), verify: false, split: true });
    assert.ok(result.split, 'the conversion reports the split');
    assert.equal(result.split.files.length, result.pages.length, 'one artifact per sheet');
    for (const f of result.split.files) {
      assert.ok(fs.existsSync(f), `part must exist: ${f}`);
      assert.ok(path.dirname(f) === path.dirname(result.master), 'parts live beside the master');
    }
    // The master stays whole.
    const masterTexts = await extractPages(result.master);
    assert.equal(masterTexts.length, result.pages.length);
    for (let i = 0; i < result.split.files.length; i++) {
      const texts = await extractPages(result.split.files[i]);
      assert.equal(texts.length, 1);
      assert.ok(texts[0].length > 0, `part ${i + 1} must not be an empty artifact`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('split composes with minify: parts read back from the compact master', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-split-minify-'));
  try {
    const src = path.resolve('test/corpus/article-short.html');
    const result = await convert(src, {
      out: path.join(dir, 'out.pdf'),
      verify: false,
      split: true,
      minify: true,
    });
    assert.ok(result.minify && result.minify.bytesAfter > 0, 'the size pass ran');
    assert.equal(result.split.files.length, result.pages.length);
    for (const f of result.split.files) {
      const doc = await PDFDocument.load(fs.readFileSync(f), { updateMetadata: false });
      assert.equal(doc.getPageCount(), 1, `a part from the minified master still loads: ${f}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
