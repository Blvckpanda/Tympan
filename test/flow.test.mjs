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
import { extractPages } from '../src/verify.js';
import { summarizeQuality } from '../src/metrics.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-flow-'));
const fixture = (name) => path.join(FIXTURES, name);
const out = (name) => path.join(OUT, name);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('flow packs short sections onto full sheets instead of one sheet each', async () => {
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

test('flow prints real page numbers from the print engine', async () => {
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

test('flow output is byte-identical across runs', async () => {
  const a = await convert(fixture('flow-prose.html'), { out: out('det-a.pdf'), flow: true });
  const b = await convert(fixture('flow-prose.html'), { out: out('det-b.pdf'), flow: true });
  assert.equal(sha(a.master), sha(b.master), 'same input, same flow bytes');
});

test('content wider than the column fails flow verification, and passes in section mode', async () => {
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

test('flow refuses options it cannot honour rather than dropping them', async () => {
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
