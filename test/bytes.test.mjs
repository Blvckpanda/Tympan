/**
 * bytes.test.mjs — `tympan bytes`, the size instrument.
 *
 * The scan is pure (Buffer in, audit out), so most of this file runs without
 * Chromium: a hand-built PDF with one object of every kind, plus the scan's
 * adversarial shapes. The one browser test exists because the instrument is
 * only useful if it scans REAL Chromium output — a fixture with a sibling
 * image is converted, then byte-arithmetic must tie out exactly: every
 * scanned byte lands in exactly one bucket.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditPdfBytes, classifyStream, formatBytesReport, BYTE_KINDS } from '../src/bytes.js';
import { convert } from '../src/index.js';
import { findChromium } from '../src/browser.js';

/**
 * A hand-built PDF with one image, one font program, one content stream,
 * one metadata stream, one page dictionary, and a xref/trailer tail.
 */
function buildFixturePdf() {
  return Buffer.from([
    '%PDF-1.4\n',
    // The stream data ends with EOL before `endstream` — PDF's own rule —
    // so the scanner must not charge that EOL to the data.
    '1 0 obj<</Subtype/Image/Width 400/Height 300/Length 6>>stream\nAB\nendstream endobj\n',
    '2 0 obj<</Filter/FlateDecode/Length1 128>>stream\nFONTBYTES-FONTBYTES\nendstream endobj\n',
    '3 0 obj<</Filter/FlateDecode>>stream\nCONTENT\nendstream endobj\n',
    '4 0 obj<</Type/Metadata/Length 4>>stream\nSELF\nendstream endobj\n',
    '5 0 obj<</Type/Page/Parent 9 0 R/MediaBox[0 0 595 842]>>endobj\n',
    'xref\n0 6\ntrailer<</Size 6/Root 7 0 R>>\n%%EOF',
  ].join(''), 'latin1');
}

test('bytes: kinds exist, in a stable print order (image first, structure last)', () => {
  assert.deepEqual([...BYTE_KINDS].slice(0, 2), ['image', 'font']);
  assert.ok(BYTE_KINDS.includes('content'));
});

test('bytes: classifyStream reads the dictionary, rule-ordered', () => {
  assert.equal(classifyStream('/Subtype/Image/Width 3/Height 3'), 'image');
  // An SMask-carrying image still says /Image first.
  assert.equal(classifyStream('/Subtype/Image/SMask 4 0 R/Width 300'), 'image');
  assert.equal(classifyStream('/Filter/FlateDecode/Length1 128'), 'font');
  assert.equal(classifyStream('/FontFile2 5 0 R/Length1 640'), 'font');
  assert.equal(classifyStream('/Type/Metadata/Length 3'), 'metadata');
  assert.equal(classifyStream('/Type/XObject/Subtype/Form'), 'form');
  // A bare /XObject carries no /Subtype: it is a paint resource, bucketed
  // with forms, NOT with the page's content list.
  assert.equal(classifyStream('/Type/XObject/BBox [0 0 4 4]'), 'form');
  assert.equal(classifyStream('/Filter/FlateDecode'), 'content');
  // A dictionary NAME containing the word triggers nothing: it is names-only.
  assert.equal(classifyStream('/XRefStreamDontCountMe/FormObjects'), 'content');
  // PDF 1.5 plumbing — the cross-reference stream and object streams — is
  // file bookkeeping, not payload: bucketed as 'other', never as content
  // (a --minify output would otherwise read as “more content”).
  assert.equal(classifyStream('/Type/XRef/W [1 4 2]'), 'other');
  assert.equal(classifyStream('/Type/ObjStm/N 17/First 119'), 'other');
});

test('bytes: the fixture audit buckets every stream and ties out', () => {
  const buf = buildFixturePdf();
  const a = auditPdfBytes(buf);
  assert.equal(a.totalBytes, buf.length);

  // The image: 2 bytes of data (`AB\n` — the \n is EOL, not data), the
  // declared /Length 6 is reported for contrast with what is on DISK.
  assert.equal(a.byKind.image.objects, 1);
  assert.equal(a.byKind.image.bytes, 2);
  assert.deepEqual(
    { w: a.byKind.image.largest.width, h: a.byKind.image.largest.height },
    { w: 400, h: 300 }
  );
  assert.equal(a.byKind.image.largest.declaredBytes, 6);

  assert.equal(a.byKind.font.objects, 1);
  assert.equal(a.byKind.font.bytes, 'FONTBYTES-FONTBYTES'.length);
  // /Length1 is the UNCOMPRESSED length of a Type1 program, a different key
  // from /Length — the on-disk measure reads /Length only, so it stays null
  // here while the image (which declares /Length 6) reports its own.
  assert.equal(a.byKind.font.largest.declaredBytes, null, "/Length1 is not /Length; the font declares none");
  assert.equal(a.byKind.content.bytes, 'CONTENT'.length);
  assert.equal(a.byKind.metadata.bytes, 4);
  assert.equal(a.byKind.form.objects, 0);

  // Ties out: every byte of a stream lands in its bucket; what remains is
  // structure (headers, dicts, xref, trailer, the object words themselves).
  const streamBytes = BYTE_KINDS.reduce((n, k) => n + a.byKind[k].bytes, 0);
  assert.equal(a.streams.reduce((n, s) => n + s.bytes, 0), streamBytes, 'streams and rollup agree');
  assert.ok(a.structureBytes > 0);
  assert.equal(a.structureObjects, 1, 'the page dict is the one non-stream object');
  assert.equal(a.pageCount, 1);
  assert.equal(a.objectCount, 5);
});

test('bytes: a stream dictionary BODY containing "endobj"-like text is not re-parsed', () => {
  // Binary junk between stream and endstream that CONTAINS `12 0 obj` and
  // `endobj`: the positional scan must resume past `endstream` and find
  // exactly the objects the file actually declares.
  const junk = 'garbage 12 0 obj JUNK endobj more junk';
  const buf = Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj<</Filter/FlateDecode>>stream\n' + junk + '\nendstream endobj\n' +
      '2 0 obj<</Subtype/Image/Width 40/Height 40/Length 3>>stream\nIMG\nendstream endobj\n' +
      'trailer<</Size 3>>\n%%EOF',
    'latin1'
  );
  const a = auditPdfBytes(buf);
  assert.equal(a.byKind.content.objects, 1);
  assert.equal(a.byKind.image.objects, 1);
  assert.equal(a.byKind.content.largest.declaredBytes, null, 'no /Length in that dict');
  // Binary junk cannot leak into the page count either.
  assert.equal(a.pageCount, null);
});

test('bytes: a truncated tail never throws and names what it scanned', () => {
  const buf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Subtype/Image/Width 10/Height 10>>stream\nIMAGEDATA\n',
    'latin1'
  );
  const a = auditPdfBytes(buf);
  assert.equal(a.totalBytes, buf.length);
  // No `endobj` ever arrived: nothing after the open object is claimed.
  assert.equal(a.objectCount, 0);
  assert.equal(a.streams.length, 0);
});

test('bytes: /Type /Pages is not counted as a page', () => {
  const buf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Pages/Kids[2 0 R]/Count 4>>endobj\n2 0 obj<</Type/Page>>endobj\ntrailer\n%%EOF',
    'latin1'
  );
  assert.equal(auditPdfBytes(buf).pageCount, 1);
});

test('bytes: formatBytesReport prints buckets, shares and the tie-out line', () => {
  const buf = buildFixturePdf();
  const a = auditPdfBytes(buf);
  const out = formatBytesReport([
    { input: 'brief.html', ok: true, totalBytes: buf.length, pages: 3, mode: 'section', audit: a },
    { input: 'deep.html', ok: false, error: 'no pages produced' },
  ]);
  const lines = out.split('\n');
  assert.match(lines[0], /\[bytes\] brief\.html — [0-9.]+ KB, 3 pages \(section mode\)/);
  assert.match(out, /image/);
  assert.match(out, /font/);
  assert.match(out, /structure[\s\S]*\(xref, dicts, trailer\)/);
  assert.match(out, /\[FAIL\] deep\.html: no pages/);
  assert.match(lines.at(-1), /tympan bytes: 2 document\(s\), [0-9.]+ KB total, 1 failed/);
  // Shares are integers and every bucket line carries one, so a reader can
  // re-add the file's composition from the report alone.
  assert.ok(/\(\s*\d+%\)/.test(out));
  // A caller can carry its own scaling line (the corpus tables do)
  const custom = formatBytesReport(
    [{ input: 'x.html', ok: true, totalBytes: buf.length, audit: a }],
    { kbLine: (n) => `${n} B` }
  );
  assert.match(custom, /x\.html — \d+ B/);
});

/* ------------------------------------------------------------------ */
/* End to end: real Chromium output (guarded like lint's tests)         */
/* ------------------------------------------------------------------ */

/** A real 2x2 PNG (red), so the sibling-image path paints an image XObject. */
const RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAAXNSR0IArs4c6QAAAAxJREFUCNdj' +
    'YGAAAAMIAH8AAJE4AAAAAElFTkSuQmCC',
  'base64'
);

test('bytes end to end: real Chromium output ties out and classifies', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-bytes-'));
  const src = path.join(dir, 'bytes-input.html');
  fs.writeFileSync(src, `<!doctype html><html><head><meta charset="utf-8"><title>bytes</title>
<style>body{background:#0b0b0b;color:#f5f2e8;font-family:Arial,sans-serif;margin:0;padding:48px}
section{height:600px}h1{font-size:48px}p{font-size:18px}</style></head><body>
<section><h1>Sized deck</h1><p>Enough surface for real fonts and a real image.</p>
<img src="photo.png"></section>
<section><h1>Second</h1><p>Another sheet, another run of glyphs.</p></section>
</body></html>`);
  fs.writeFileSync(path.join(dir, 'photo.png'), RED_PNG);
  try {
    const result = await convert(src, { out: path.join(dir, 'bytes-input.pdf'), verify: false });
    const buf = fs.readFileSync(result.master);
    const a = auditPdfBytes(buf);

    // The arithmetic ties out FIRST — the report is worthless otherwise.
    const streamBytes = BYTE_KINDS.reduce((n, k) => n + a.byKind[k].bytes, 0);
    assert.equal(a.streams.reduce((n, s) => n + s.bytes, 0), streamBytes);
    assert.ok(streamBytes + a.structureBytes <= buf.length, 'scanned bytes never exceed the file');

    // A Chromium-printed document embeds at least one font program and one
    // paint list per sheet, and the inline PNG becomes a real image XObject.
    assert.ok(a.byKind.font.objects >= 1, `fonts: ${a.byKind.font.objects}`);
    assert.ok(a.byKind.content.objects >= 1, `content: ${a.byKind.content.objects}`);
    assert.ok(a.byKind.image.objects >= 1, `images: ${JSON.stringify(a.byKind.image)}`);
    assert.equal(a.byKind.image.largest.width, 2);
    assert.equal(a.byKind.image.largest.height, 2);

    const report = formatBytesReport([
      { input: 'bytes-input.html', ok: true, totalBytes: buf.length, pages: result.pages.length, mode: result.layout, audit: a },
    ]);
    assert.ok(Number.isFinite(a.totalBytes) && a.totalBytes === buf.length);
    assert.match(report, /structure/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
