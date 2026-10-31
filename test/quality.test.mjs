/**
 * quality.test.mjs — end-to-end tests for the page-quality wiring.
 *
 * metrics.test.mjs pins the arithmetic; this file pins that the numbers are
 * MEASURED FROM THE RIGHT PLACE and actually reach the report:
 *   - sparse content on a fully painted sheet is reported as sparse (a
 *     coverage-based metric scores every pixel as covered — the reading that
 *     once made a four-page document look clean);
 *   - a section assembled out of <div> blocks is not reported as ending on a
 *     stranded heading (the false positive found on the Kitch pot-meter
 *     sheet, where a tag allowlist let the section's <h2> win by default);
 *   - a section that really does end on a heading IS reported;
 *   - the rollup and the `--json` report agree with the page records.
 *
 * Needs Chromium; skips cleanly without it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convert } from '../src/index.js';
import { buildJsonReport } from '../src/report.js';
import { findChromium } from '../src/browser.js';

const DOC = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>quality fixture</title>
<style>
  html,body{margin:0;background:#123456;color:#fff}
  main{max-width:774px;margin:0 auto}
  section{padding:8px}
</style></head>
<body><main>
  <section class="page-section" id="sparse"><p>One short line on a painted sheet.</p></section>
  <section class="page-section" id="div-built">
    <h2>Built from divs</h2>
    <div class="row"><div class="label">1 of 6</div><div class="note">content follows the heading</div></div>
    <div class="row"><div class="label">4 of 6</div><div class="note">and it ends here</div></div>
  </section>
  <section class="page-section" id="heading-only"><h2>Only a heading</h2></section>
</main></body></html>`;

test('quality: sparse pages, stranded headings and the report wiring', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-quality-'));
  const src = path.join(dir, 'quality.html');
  fs.writeFileSync(src, DOC);
  try {
    const result = await convert(src, { out: path.join(dir, 'quality.pdf') });

    assert.equal(result.layout, 'section');
    assert.equal(result.pages.length, 3, 'one record per page');
    assert.equal(result.verification.outputs[0].pages, 3);

    // 1. Sparse content on a fully painted sheet is still sparse.
    const sparse = result.pages[0];
    assert.ok(sparse.fillRatio > 0 && sparse.fillRatio < 0.2, `sparse fill: ${sparse.fillRatio}`);
    assert.ok(sparse.blankTailPx > 800, `blank tail: ${sparse.blankTailPx}`);
    assert.equal(sparse.underfilled, true);
    assert.equal(sparse.usableHeightPx, 1045, 'A4 portrait text area in CSS px');

    // 2. div-built content does not read as a stranded heading...
    const divBuilt = result.pages[1];
    assert.equal(divBuilt.lastBlockKind, 'text', 'the last block is a div, not the heading');
    assert.equal(divBuilt.strandedHeading, false);

    // 3. ...while a section that really ends on a heading is reported.
    const headingOnly = result.pages[2];
    assert.equal(headingOnly.lastBlockKind, 'heading');
    assert.equal(headingOnly.strandedHeading, true);
    assert.deepEqual(result.quality.strandedHeadings, [3]);

    // 4. The rollup agrees with the page records, and the JSON report carries
    //    both (so CI can gate on a page number, not just a mean).
    assert.equal(result.quality.pages, 3);
    const mean = (sparse.fillRatio + divBuilt.fillRatio + headingOnly.fillRatio) / 3;
    assert.ok(Math.abs(result.quality.meanFill - mean) < 0.002, `mean ${result.quality.meanFill} vs ${mean}`);
    const json = buildJsonReport(result, { input: 'quality.html' });
    assert.equal(json.layout, 'section');
    assert.equal(json.pages.length, 3);
    assert.ok(json.quality, 'quality block present');
    assert.deepEqual(json.quality.underfilledPages, result.quality.underfilledPages);
    assert.equal(json.quality.pages, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
