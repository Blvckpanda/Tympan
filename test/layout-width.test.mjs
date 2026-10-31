/**
 * layout-width.test.mjs — Phase 0 of 0.8.0: the layout must be the column.
 *
 * Three defects are pinned here, each proved before it was fixed:
 *
 *   1. `measureBlockInPage` took `documentElement.scrollWidth`, which is floored
 *      by the viewport tympan itself created. A 700px document measured 774px
 *      and every page printed at scale 0.902 to "fit" a 698px column.
 *   2. The resolved layout width was a constant (774) rather than the sheet's
 *      text column (698), so the same scale was applied even when the source
 *      declared nothing.
 *   3. `buildCleanTemplate` copied the source's first <style> verbatim, so the
 *      document's own `@media print` rules ran at print time — while
 *      `tympan lint` told users tympan ignored them "by design".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, resolveGeometry } from '../src/pipeline.js';
import { findChromium } from '../src/browser.js';
import { lintDocument } from '../src/lint.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-width-'));
const fixture = (name) => path.join(FIXTURES, name);
const out = (name) => path.join(OUT, name);

test('source print CSS never reaches the printed page', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const base = await convert(fixture('print-css-base.html'), { out: out('base.pdf'), verify: false });
  // The spill probe is identical except for `@media print{min-height:2000px}`.
  // Honoured, that rule makes every section 2000px tall and the spill guard
  // throws after six 10% shrink retries — so this call failing is the bug.
  const spill = await convert(fixture('print-css-spill.html'), { out: out('spill.pdf'), verify: false });

  assert.equal(spill.quality.pages, 2, 'the print-only rule must not add a page');
  assert.equal(spill.quality.pages, base.quality.pages);
  assert.deepEqual(
    spill.pages.map((p) => p.contentHeightPx),
    base.pages.map((p) => p.contentHeightPx),
    'print-only rules must not change the measured layout'
  );
});

test('the print layout is capped at the printable column, so widthScale is 1', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const r = await convert(fixture('width-narrow.html'), { out: out('narrow.pdf'), verify: false });
  assert.equal(r.geometry.columnW, 698, 'A4 portrait column: (8.27 - 1.0) * 96');
  assert.equal(r.contentMaxWidth, 600, 'the source asked for 600px and fits');
  for (const p of r.pages) {
    assert.equal(p.widthScale, 1, `page ${p.index} must not be width-scaled`);
    assert.equal(p.scaleApplied, 1, `page ${p.index} must not be shrunk at all`);
    assert.equal(p.scaledFor, 'none');
  }
});

test('contentWidth narrows the layout; the column still wins when it cannot fit', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const narrow = await convert(fixture('width-narrow.html'), {
    out: out('narrow-500.pdf'),
    contentWidth: 500,
    verify: false,
  });
  assert.equal(narrow.contentMaxWidth, 500);
  assert.equal(narrow.contentWidthRequested, 500);
  assert.equal(narrow.pages[0].widthScale, 1);

  // 900px does not fit A4's 698px column. It is capped rather than printed and
  // scaled, and the geometry the report carries says so.
  const wide = await convert(fixture('width-narrow.html'), {
    out: out('narrow-900.pdf'),
    contentWidth: 900,
    verify: false,
  });
  assert.equal(wide.geometry.contentW, 698);
  assert.equal(wide.contentMaxWidth, 698);
  assert.equal(wide.contentWidthRequested, 900);
  assert.equal(wide.pages[0].widthScale, 1);
});

test('lint: the column rule is an invariant now, not a per-page finding', () => {
  const geo = resolveGeometry({});
  const page = {
    index: 1,
    contentHeightPx: 800,
    usableHeightPx: 1045,
    blankTailPx: 245,
    fillRatio: 0.766,
    scaleApplied: 1,
    widthScale: 1,
    scaledFor: 'none',
  };
  const ok = lintDocument({
    input: 'kitch.html',
    pages: [page],
    geometry: geo,
    layoutWidthPx: geo.contentW,
    requestedLayoutWidthPx: 774,
  });
  assert.equal(
    ok.findings.some((f) => f.rule === 'column-narrower-than-layout'),
    false,
    'a 698px layout in a 698px column is the fixed state'
  );
  // The document did ask for 774px, and it was capped on purpose: say so once.
  const clampNote = ok.findings.find((f) => f.rule === 'content-width-clamped');
  assert.ok(clampNote, 'the cap must be reported, not silent');
  assert.equal(clampNote.severity, 'note');
  assert.equal(clampNote.requestedWidthPx, 774);
  assert.equal(clampNote.columnWidthPx, 698);

  // A caller that assembles its own geometry wider than the column still gets
  // the old warning — that is the pipeline-bug case the rule exists for.
  const bad = lintDocument({
    pages: [page],
    geometry: geo,
    layoutWidthPx: 774,
  });
  assert.ok(bad.findings.some((f) => f.rule === 'column-narrower-than-layout'));
});
