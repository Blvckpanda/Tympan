/**
 * stamp.test.mjs — the watermark pass (SPEC §4 Phase 2's "watermark,
 * stamping" item).
 *
 * A watermark is document semantics: the proof the reader checks is that the
 * text is THERE, on every page, and that the same file stamps to the same
 * bytes. The placement and sizing are pure functions of page size and the
 * font's own advance widths, so they are asserted directly; the two
 * Chromium-guarded tests exist because the pass must behave on real
 * converter output — and because stamp + minify is the composition the
 * pipeline actually runs (semantics first, size pass second).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  stampPdf,
  placementFor,
  fontSizeFor,
  STAMP_MIN_SIZE,
  STAMP_MAX_SIZE,
  STAMP_OPACITY,
} from '../src/stamp.js';
import { convert, extractPages } from '../src/index.js';
import { findChromium } from '../src/browser.js';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * A text-bearing fixture pdf-lib can produce deterministically: three pages,
 * each with a heading and a body line (both extractable), the stamp target.
 * The SAME buffer is used for every stamping call so byte-determinism tests
 * compare the pass, not the fixture builder.
 */
async function buildThreePageFixture() {
  const pdf = await PDFDocument.create();
  pdf.setProducer('tympan stamp fixture');
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

test('stamp: exported knobs are numbers a style gate can print', () => {
  assert.equal(typeof STAMP_OPACITY, 'number');
  assert.ok(STAMP_OPACITY > 0 && STAMP_OPACITY < 0.5, 'a watermark must be faint');
  assert.equal(typeof STAMP_MIN_SIZE, 'number');
  assert.equal(typeof STAMP_MAX_SIZE, 'number');
});

test('stamp: the line starts where centring the middle of the text requires', () => {
  const center = { x: 297.5, y: 421 };
  const textWidth = 400;
  const place = placementFor({ center, textWidth, size: 48 });
  // The line's MIDDLE must land on the page centre; at 45 degrees the
  // offsets are equal on both axes (cos(45) === sin(45)).
  assert.ok(Math.abs(place.x + (textWidth / 2) * Math.SQRT1_2 - center.x) < 1e-9);
  assert.ok(Math.abs(place.y + (textWidth / 2) * Math.SQRT1_2 - center.y) < 1e-9);
  assert.equal(place.rotateDegrees, 45);
});

test('stamp: font size fills the diagonal and clamps, deterministically', () => {
  // unitWidth 0.5 at size 10 -> the diagonal share decides the size.
  const a4 = { width: 595, height: 842 };
  const diagonal = Math.sqrt(595 * 595 + 842 * 842);
  // unitWidth = target / desired-size: size 60 for an A4 page.
  const mid = fontSizeFor(a4, (diagonal * 0.6) / 60);
  assert.ok(Math.abs(mid - 60) < 1e-9, `expected the unclamped target, got ${mid}`);
  // A tiny page with coarse metrics falls to the readable floor, not NaN.
  // (50x50 diagonal*0.6/10 = 4.2 points -> floored.)
  assert.equal(fontSizeFor({ width: 50, height: 50 }, 10), STAMP_MIN_SIZE);
  // A huge page cannot inflate the text past the style ceiling.
  assert.equal(fontSizeFor({ width: 6000, height: 9000 }, 0.001), STAMP_MAX_SIZE);
  // Degenerate metrics degrade to the floor instead of NaN arithmetic.
  assert.equal(fontSizeFor(a4, 0), STAMP_MIN_SIZE);
});

test('stamp: same file, same stamp, same bytes (deterministic by construction)', async () => {
  const fixture = await buildThreePageFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-stamp-det-'));
  try {
    const a = path.join(dir, 'a.pdf');
    const b = path.join(dir, 'b.pdf');
    fs.writeFileSync(a, fixture);
    fs.writeFileSync(b, fixture);
    const stats = await stampPdf(a, 'DRAFT');
    await stampPdf(b, 'DRAFT');
    assert.deepEqual(fs.readFileSync(b), fs.readFileSync(a), 're-stamping the same file must not move a byte');
    assert.equal(stats.pages, 3);
    assert.equal(stats.text, 'DRAFT');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stamp: every page carries the text in its extractable layer', async () => {
  const fixture = await buildThreePageFixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-stamp-text-'));
  try {
    const file = path.join(dir, 'stamped.pdf');
    fs.writeFileSync(file, fixture);
    const stats = await stampPdf(file, 'DRAFT');
    assert.equal(stats.pages, 3);
    const pages = await extractPages(file);
    assert.equal(pages.length, 3);
    pages.forEach((text, i) => {
      assert.ok(
        text.includes('DRAFT'),
        `page ${i + 1} must read as the watermark it was stamped with`
      );
      // And the fixture's own text survived the pdf-lib round-trip.
      assert.ok(text.includes('Fixture page'), 'existing content must survive');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stamp: refuses blank text and non-PDF bytes, loudly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-stamp-refuse-'));
  try {
    await assert.rejects(stampPdf(path.join(dir, 'x.pdf'), '   '), /text is required/);
    await assert.rejects(stampPdf(path.join(dir, 'x.pdf'), ''), /text is required/);
    const junk = path.join(dir, 'junk.pdf');
    fs.writeFileSync(junk, 'not a pdf at all');
    await assert.rejects(stampPdf(junk, 'DRAFT'), /cannot load/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stamp: convert({ watermark }) stamps every page and reports it', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-stamp-e2e-'));
  try {
    const src = path.resolve('test/corpus/article-short.html');
    const plain = await convert(src, { out: path.join(dir, 'plain.pdf'), verify: false });
    const result = await convert(src, { out: path.join(dir, 'out.pdf'), verify: false, watermark: 'DRAFT' });
    assert.ok(result.stamp, 'the conversion reports the stamp');
    assert.equal(result.stamp.text, 'DRAFT');
    assert.equal(result.stamp.pages, plain.pages.length, 'the page count must not move');
    // pdfjs is the text-layer instrument: the watermark is on EVERY page,
    // and the document's own text is still there next to it.
    const pages = await extractPages(result.master);
    assert.equal(pages.length, plain.pages.length);
    pages.forEach((text, i) => {
      assert.ok(text.includes('DRAFT'), `page ${i + 1} must carry the watermark`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stamp: convert({ email }) stamps the email variant too', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-stamp-email-'));
  try {
    const src = path.resolve('test/corpus/article-short.html');
    const result = await convert(src, {
      out: path.join(dir, 'out.pdf'),
      verify: false,
      email: true,
      watermark: 'DRAFT',
    });
    assert.ok(result.email, 'the email artifact exists');
    const pages = await extractPages(result.email);
    assert.ok(pages.length > 0);
    pages.forEach((text, i) => {
      assert.ok(text.includes('DRAFT'), `email page ${i + 1} must carry the stamp`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stamp and minify compose: semantics first, size pass second', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-stamp-minify-'));
  try {
    const src = path.resolve('test/corpus/article-short.html');
    const result = await convert(src, {
      out: path.join(dir, 'out.pdf'),
      verify: false,
      watermark: 'DRAFT',
      minify: true,
    });
    assert.ok(result.stamp && result.stamp.pages > 0);
    assert.ok(result.minify && result.minify.bytesAfter > 0, 'the size pass ran on the stamped file');
    const pages = await extractPages(result.master);
    pages.forEach((text, i) => {
      assert.ok(text.includes('DRAFT'), `page ${i + 1} must survive both passes with its watermark`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
