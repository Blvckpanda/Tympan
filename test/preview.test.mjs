/**
 * preview.test.mjs — `tympan preview`.
 *
 * The preview's whole value is that it must not disagree with the converter,
 * so the central test is an agreement test: convert a document, measure it for
 * preview, and check the two reports the same pages at the same fill. The rest
 * covers the pure pieces (sheet geometry, content types, the page's own
 * contract) and the server routes end to end.
 *
 * Needs Chromium for the measurement tests; they skip cleanly without it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPreviewReport,
  createPreviewServer,
  previewPage,
  sheetSizePx,
  contentTypeFor,
} from '../src/preview.js';
import { resolveGeometry, convert } from '../src/pipeline.js';
import { findChromium } from '../src/browser.js';

const DOC = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>preview fixture</title>
<style>
  html,body{margin:0;background:#ffffff;color:#111}
  main{max-width:774px;margin:0 auto}
  section{padding:16px}
  @media print { section { break-after: page } }
</style></head>
<body><main>
  <section class="page-section" id="sparse"><p>One short line.</p></section>
  <section class="page-section" id="prose"><h2>Prose</h2><p>${('words that fill a column. ').repeat(20)}</p></section>
  <section class="page-section" id="heading-only"><h3>Nothing follows this heading</h3></section>
  <section class="page-section" id="image"><h3>Figure</h3><img src="missing.png" alt="missing"></section>
</main></body></html>`;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-preview-'));
}

test('sheetSizePx: the sheet the overlay is drawn on', () => {
  assert.deepEqual(sheetSizePx(resolveGeometry({})), { w: 794, h: 1122 });
  assert.deepEqual(sheetSizePx(resolveGeometry({ orientation: 'landscape' })), { w: 1122, h: 794 });
  assert.deepEqual(sheetSizePx(resolveGeometry({ format: 'letter' })), { w: 816, h: 1056 });
});

test('contentTypeFor: named types only, never sniffed', () => {
  assert.equal(contentTypeFor('sheet-0.jpg'), 'image/jpeg');
  assert.equal(contentTypeFor('p001.png'), 'image/png');
  assert.equal(contentTypeFor('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentTypeFor('report.json'), 'application/json; charset=utf-8');
  assert.equal(contentTypeFor('something.bin'), 'application/octet-stream');
});

test('previewPage: carries the overlay contract the server serves', () => {
  const page = previewPage({ title: 'preview — x.html' });
  assert.match(page, /<title>preview — x\.html<\/title>/);
  for (const hook of ['/events', '/sheets/', 'fitSheets', '.usable', '.break', 'strandedHeading', 'Overlay on/off', 'Re-measure']) {
    assert.ok(page.includes(hook), `page must contain ${hook}`);
  }
  assert.doesNotMatch(page, /<script src=/, 'no external scripts: the preview works offline');
});

test('preview: the measurement agrees with the converter page for page', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  const src = path.join(dir, 'preview.html');
  const shotDir = path.join(dir, 'sheets');
  fs.mkdirSync(shotDir);
  fs.writeFileSync(src, DOC);
  try {
    const report = await buildPreviewReport({ input: src, shotDir });
    assert.equal(report.strategy, 'page-section-class');
    assert.equal(report.pages.length, 4);
    assert.deepEqual(report.sheet, { w: 794, h: 1122 });

    // Per-page numbers, not a document average.
    const sparse = report.pages[0];
    assert.ok(sparse.fillRatio < 0.2, `sparse fill ${sparse.fillRatio}`);
    assert.equal(sparse.underfilled, true);
    assert.ok(sparse.blankTailPx > 800);
    assert.equal(report.pages[2].strandedHeading, true, 'the heading-only sheet strands its content');
    assert.equal(report.pages[1].strandedHeading, false);
    assert.ok(report.quality.underfilledPages.length >= 3);
    assert.match(report.qualityLine, /fill: mean \d+%/);

    // The audit surfaces the two things the document really does wrong: its
    // own print CSS and an image that never loads.
    assert.ok(report.findings.some((f) => f.rule === 'print-css-in-source'));
    assert.ok(report.findings.some((f) => f.rule === 'broken-asset' && f.severity === 'error'));
    assert.equal(report.summary.ok, false);
    assert.ok(report.findings.some((f) => f.rule === 'page-underfilled'));

    // Each page has a rendering to show, served by name.
    for (const p of report.pages) {
      assert.ok(p.shot, `page ${p.index} has a sheet image`);
      assert.equal(contentTypeFor(p.shot), 'image/jpeg');
      assert.ok(fs.existsSync(path.join(shotDir, p.shot)));
    }

    // The agreement test: the converter's own report must say the same thing
    // about the same sheets. A preview that measured differently would lie.
    const converted = await convert(src, { out: path.join(dir, 'out.pdf'), verify: false });
    assert.equal(converted.pages.length, report.pages.length);
    for (let i = 0; i < converted.pages.length; i++) {
      const a = converted.pages[i];
      const b = report.pages[i];
      assert.equal(b.sectionId, a.sectionId, `page ${i + 1} is the same section`);
      assert.ok(
        Math.abs(a.fillRatio - b.fillRatio) < 0.05,
        `page ${i + 1} fill agrees: converter ${a.fillRatio} vs preview ${b.fillRatio}`
      );
      assert.equal(b.strandedHeading, a.strandedHeading, `page ${i + 1} stranded-heading agrees`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('preview server: serves the page, the sheets, the stream and a refresh', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  const src = path.join(dir, 'preview.html');
  fs.writeFileSync(src, DOC);
  let server;
  try {
    server = await createPreviewServer({ input: src, port: 0 });
    assert.ok(server.port > 0, 'port 0 means "pick a free one"');
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const report = server.report();
    assert.equal(report.pages.length, 4);

    const page = await fetch(server.url + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /tympan preview/);

    const sheet = await fetch(`${server.url}/sheets/${report.pages[0].shot}`);
    assert.equal(sheet.status, 200);
    assert.equal(sheet.headers.get('content-type'), 'image/jpeg');
    assert.equal(Buffer.from(await sheet.arrayBuffer()).subarray(0, 2).toString('hex'), 'ffd8', 'a real JPEG');

    const missing = await fetch(`${server.url}/sheets/does-not-exist.jpg`);
    assert.equal(missing.status, 404);

    // The stream's first frame is the current report, so a client that
    // connects late sees the measurement immediately rather than waiting for
    // a change that may never come.
    const stream = await fetch(server.url + '/events');
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    const { value } = await reader.read();
    const frame = Buffer.from(value).toString('utf8');
    assert.match(frame, /^data: \{/);
    const payload = JSON.parse(frame.replace(/^data: /, '').trim());
    assert.equal(payload.event, 'report');
    assert.equal(payload.report.pages.length, 4);
    await reader.cancel();

    // Live reload: saving the file re-measures and the page reports the change.
    const res = await fetch(server.url + '/refresh', { method: 'POST' });
    assert.equal(res.status, 202);
    await server.refresh();
    assert.equal(server.report().pages.length, 4);

    fs.writeFileSync(src, DOC.replace('id="heading-only"><h3>Nothing follows this heading</h3>', 'id="heading-only"><p>now with a paragraph</p>'));
    await server.refresh();
    const after = server.report();
    assert.equal(after.pages[2].strandedHeading, false, 'the edited page no longer strands its heading');
    assert.equal(after.pages[2].sectionId, 'heading-only', 'the same section, re-measured');
  } finally {
    if (server) await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
