/**
 * flow.test.mjs — `--flow`: one print, Chromium paginates, we verify what it did.
 *
 * Flow mode cannot use section mode's central assertion (pages === sections):
 * flowing is the point, so the page count is whatever the content needs. It
 * therefore proves a different set of things — pages were produced, none is
 * blank, nothing was clipped at the page edge, nothing overflowed the column,
 * and the scale is 1 because it flowed rather than shrank.
 *
 * The one invariant it cannot prove is keep-together: Chromium never reports
 * which page a DOM block landed on. That is asserted here as UNMEASURED, so a
 * future change cannot quietly turn it into "verified clean".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/pipeline.js';
import { findChromium } from '../src/browser.js';
import { extractPages } from '../src/verify.js';
import { summarizeQuality } from '../src/metrics.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-flow-'));
const fixture = (name) => path.join(FIXTURES, name);
const out = (name) => path.join(OUT, name);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('flow packs short sections onto full sheets instead of one sheet each', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const r = await convert(fixture('flow-prose.html'), { out: out('prose.pdf'), flow: true });
  assert.equal(r.layout, 'flow');
  assert.ok(r.pages.length < 10, `10 sections must not need 10 pages (got ${r.pages.length})`);
  assert.ok(r.pages.length >= 1);
  // Flowing absorbs height with another page; it must never shrink the page.
  for (const p of r.pages) {
    assert.equal(p.scaleApplied, 1, `page ${p.index} must not be scaled`);
    assert.equal(p.widthScale, 1);
    assert.equal(p.scaledFor, 'none');
    // Unmeasured is `null`, not `true`.
    assert.equal(p.keptTogether, null, 'flow cannot assert keep-together');
    assert.equal(p.measuredFrom, 'pdf', 'fill comes from the printed file');
  }
  assert.equal(r.verification.mode, 'flow');
  assert.equal(r.verification.ok, true);
  assert.deepEqual(r.verification.blankPages, []);
  assert.deepEqual(r.verification.clippedPages, []);
  assert.equal(r.verification.overflowPx, 0);
  assert.deepEqual(r.verification.keepTogether, { measured: false, blocks: r.flow.keepTogetherBlocks });
  // The first sheet should be nearly full: that is the whole point.
  assert.ok(r.quality.meanFill > 0.4, `mean fill ${r.quality.meanFill} should beat section mode`);
});

test('flow prints real page numbers from the print engine', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const r = await convert(fixture('flow-prose.html'), { out: out('numbered.pdf'), flow: true, pageNumbers: true });
  const pages = await extractPages(r.master);
  assert.equal(pages.length, r.pages.length);
  for (let i = 0; i < pages.length; i++) {
    assert.ok(
      pages[i].includes(`${i + 1} / ${pages.length}`),
      `page ${i + 1} should carry "${i + 1} / ${pages.length}"`
    );
  }
});

test('flow output is byte-identical across runs', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const a = await convert(fixture('flow-prose.html'), { out: out('det-a.pdf'), flow: true });
  const b = await convert(fixture('flow-prose.html'), { out: out('det-b.pdf'), flow: true });
  assert.equal(sha(a.master), sha(b.master), 'same input, same flow bytes');
});

test('content wider than the column fails flow verification, and passes in section mode', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  // Flow cannot shrink a 1600px block: Chromium clips it at the page edge.
  // That must be a failed conversion, not a silently cropped PDF.
  const flow = await convert(fixture('flow-overflow.html'), { out: out('overflow-flow.pdf'), flow: true });
  assert.equal(flow.verification.ok, false);
  assert.ok(flow.verification.overflowPx > 0, 'the DOM overflow is what caught it');

  // Section mode scales the same document to fit, which is a legitimate
  // different answer — proof the guard is flow-specific, not a broken fixture.
  const section = await convert(fixture('flow-overflow.html'), { out: out('overflow-section.pdf') });
  assert.equal(section.layout, 'section');
  assert.notEqual(section.verification.ok, false);
});

test('flow refuses options it cannot honour rather than dropping them', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  // outline WAS rejected when flow mode could not map sections to pages;
  // plan section 3.5 gave it the text-layer mapping (covered in w3.test.mjs).
  // email remains impossible: flow prints one document, not a downscaled variant.
  await assert.rejects(
    () => convert(fixture('flow-prose.html'), { out: out('x.pdf'), flow: true, email: true }),
    /email is section-mode only/
  );
});

test('metrics: an unmeasured keep-together is not reported as a split', () => {
  const q = summarizeQuality([
    { index: 1, contentHeightPx: 900, usableHeightPx: 1045, keptTogether: null },
    { index: 2, contentHeightPx: 900, usableHeightPx: 1045, keptTogether: false },
  ]);
  assert.deepEqual(q.splitKeepTogether, [2], 'only the measured split counts');
});

test('flow: a footer nested in the last section prints once, not twice', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  // The Harbor-Gardens-style brief that caught the bug: the footer is INSIDE
  // the last section, and the pull-out merge used to grab it with a bare
  // querySelector('footer') anyway, then mergeFooter appended a copy of the
  // band into the same section's html — the flow body carried the footer
  // text twice. Direct-child scoping leaves in-section content alone.
  const src = path.join(OUT, 'footer-in-section.html');
  fs.writeFileSync(
    src,
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>nested footer</title>' +
    '<style>main{margin:0 auto;max-width:800px}.page-section{padding:40px;margin:0 0 20px}' +
    'footer{font-size:12px;padding:8px 0;text-align:center}</style></head><body><main>' +
    '<section class="page-section" id="one"><h1>One</h1>' + Array.from({ length: 30 }, (_, i) => `<p>Paragraph ${i + 1} of the first section body.</p>`).join('') + '</section>' +
    '<section class="page-section" id="two"><h1>Two</h1><p>Second section body.</p>' +
    '<footer>NUMBERED-SIGIL-9F3</footer></section>' +
    '</main></body></html>'
  );
  const r = await convert(src, { out: out('nested-footer.pdf'), flow: true });
  assert.equal(r.layout, 'flow');
  const pages = await extractPages(r.master);
  const occurrences = pages.reduce((n, text) => n + (text.match(/NUMBERED-SIGIL-9F3/g) || []).length, 0);
  assert.equal(occurrences, 1, `the footer text must appear exactly once (got ${occurrences})`);
});
