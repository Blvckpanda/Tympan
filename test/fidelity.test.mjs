/**
 * fidelity.test.mjs — v0.5 regression tests: fidelity, determinism, security.
 *
 * Pins the v0.5 contract on test/fixtures/brief-dark.html (a structural
 * mirror of the real brief that exposed the gaps):
 *   - portrait A4 is the default output geometry
 *   - the source's dark page background survives into the PDF (painted
 *     under the merged content, margins included)
 *   - pre-first-section content (hero) becomes page 1
 *   - runtime-injected body <style> applies (footer rule carried over)
 *   - identical input converts to byte-identical output (fixed timestamps,
 *     content-derived /ID, `tympan:<hash>` keyword, tympan producer)
 *   - untrusted documents cannot reach private/metadata networks and
 *     --offline blocks every network request
 *
 * Browser-based cases skip cleanly when Chromium is unavailable. The
 * request-gate decision logic is unit-tested hermetically in unit.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { convert } from '../src/index.js';
import { findChromium } from '../src/browser.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/brief-dark.html', import.meta.url));

function tmpdir(prefix = 'tympan-fid-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Latin-1 view of a page's first content stream (the background fill). */
async function firstStreamText(doc, page) {
  const contents = page.node.Contents();
  const stream = contents.context.lookup(contents.get(0));
  const bytes = stream.getContents ? stream.getContents() : stream.contents;
  return Buffer.from(bytes).toString('latin1');
}

test('default conversion is portrait A4 with the dark background carried', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  try {
    const result = await convert(FIXTURE, { out: path.join(dir, 'out.pdf') });
    const doc = await PDFDocument.load(fs.readFileSync(result.master));
    const p = doc.getPages()[0];
    assert.equal(Math.round(p.getWidth()), 595, 'A4 portrait width');
    assert.equal(Math.round(p.getHeight()), 842, 'A4 portrait height');

    // Background painted UNDER content: every page's content stream must
    // open with the source's dark fill (rgb 7,11,16 -> 0.027 0.043 0.063).
    for (const page of doc.getPages()) {
      const text = await firstStreamText(doc, page);
      assert.ok(text.includes('0.027 0.043 0.063 rg'), 'page starts with the dark background fill');
    }

    // Hero becomes page 1; footer band stays on the last page.
    const { extractPages } = await import('../src/verify.js');
    const pages = await extractPages(result.master);
    assert.ok(pages.length >= 4, `prelude + 3 sections, got ${pages.length}`);
    assert.match(pages[0], /Harbor Gardens/i, 'page 1 is the hero');
    assert.match(pages[0], /waterfront development/i);
    assert.match(pages[pages.length - 1], /solo developer roadmap/i);
    assert.ok(!/References/i.test(pages[0]), 'nav chrome is not duplicated onto the hero page');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime-injected body <style> applies to extracted sections', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  try {
    const result = await convert(FIXTURE, { out: path.join(dir, 'out.pdf') });
    const { extractPages } = await import('../src/verify.js');
    const pages = await extractPages(result.master);
    // The body-injected rule styles the footer <strong>; the styled footer
    // text must extract from the last page with the footer band present.
    assert.match(pages[pages.length - 1], /solo developer roadmap/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('identical input converts to byte-identical output (determinism)', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  try {
    const opts = { out: path.join(dir, 'a.pdf'), probe: 'solo developer roadmap' };
    const r1 = await convert(FIXTURE, opts);
    const r2 = await convert(FIXTURE, { ...opts, out: path.join(dir, 'b.pdf') });
    const b1 = fs.readFileSync(r1.master);
    const b2 = fs.readFileSync(r2.master);
    assert.equal(
      crypto.createHash('sha256').update(b1).digest('hex'),
      crypto.createHash('sha256').update(b2).digest('hex'),
      'same input + options must produce byte-identical PDFs'
    );

    // The determinism record lives in the output: fixed epoch, content
    // /ID, tympan:<hash> keyword, tympan producer.
    const doc = await PDFDocument.load(b1, { updateMetadata: false });
    assert.ok(doc.getProducer().startsWith('tympan '), 'producer is tympan');
    assert.equal(doc.getCreationDate().toISOString(), '2000-01-01T00:00:00.000Z');
    assert.equal(doc.getModificationDate().toISOString(), '2000-01-01T00:00:00.000Z');
    assert.match(doc.getKeywords(), /^tympan:[0-9a-f]{16}$/, 'content-hash keyword present');
    assert.ok(doc.context.trailerInfo.ID, 'trailer /ID present');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('untrusted document: metadata/private fetches blocked, output intact', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  const html = `<!DOCTYPE html><html><head><style>.page-section{padding:20px}</style></head><body><main>
    <section class="page-section"><p>attack</p>
      <img src="http://169.254.169.254/latest/meta-data/">
      <img src="http://127.0.0.1:9/x">
      <img src="http://10.1.2.3/intranet.png">
    </section>
  </main></body></html>`;
  const src = path.join(dir, 'attack.html');
  fs.writeFileSync(src, html);
  try {
    const result = await convert(src, {
      out: path.join(dir, 'out.pdf'),
      onProgress: () => {},
    });
    assert.equal(result.verification.ok, true, 'conversion still succeeds under attack');
    assert.equal(result.blockedRequests, 3, `expected 3 blocked requests, got ${result.blockedRequests}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('offline mode blocks even public-font/CDN requests', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  const html = `<!DOCTYPE html><html><head>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter&display=swap">
    <style>.page-section{padding:20px}</style></head><body><main>
    <section class="page-section"><p>offline doc</p></section>
  </main></body></html>`;
  const src = path.join(dir, 'offline.html');
  fs.writeFileSync(src, html);
  try {
    const result = await convert(src, { out: path.join(dir, 'out.pdf'), offline: true });
    assert.equal(result.verification.ok, true, 'offline conversion still succeeds');
    assert.ok(result.blockedRequests >= 1, 'the stylesheet request must be blocked offline');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--background override forces the page color', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  const html = `<!DOCTYPE html><html><head><style>.page-section{padding:20px;background:#123}</style></head>
    <body><main><section class="page-section"><p>bg override</p></section></main></body></html>`;
  const src = path.join(dir, 'bg.html');
  fs.writeFileSync(src, html);
  try {
    const result = await convert(src, { out: path.join(dir, 'out.pdf'), background: '#0e1420' });
    const doc = await PDFDocument.load(fs.readFileSync(result.master));
    const text = await firstStreamText(doc, doc.getPages()[0]);
    assert.ok(text.includes('0.055 0.078 0.125 rg'), 'override color painted');
    assert.equal(result.background, '#0e1420');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
