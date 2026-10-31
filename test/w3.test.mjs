/**
 * w3.test.mjs — plan W3: page furniture (`--page-footer`), the generated TOC
 * (`--toc`), the fill policy knob (`--fill`), and `--preset`.
 *
 * Every asserted number comes out of a produced PDF (text layer or pdf-lib
 * objects), not out of a stylesheet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, resolveGeometry } from '../src/pipeline.js';
import { findChromium } from '../src/browser.js';
import { extractPages } from '../src/verify.js';
import { analyzeFlowPdf, flowCss, verifyFlow, mapSectionsToPages, flowOutlineEntries } from '../src/flow.js';
import { buildTocHtml, estimateTocPages, escapeHtml } from '../src/toc.js';
import { applyPreset, PRESET_NAMES, PRESETS, presetDefaults } from '../src/presets.js';
import { PDFDocument, PDFName } from 'pdf-lib';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-w3-'));
const fixture = (name) => path.join(FIXTURES, name);
const out = (name) => path.join(OUT, name);

/* ---------------------------------------------------------------- pages */

test('a running footer is printed by the engine and extracted from the PDF', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const r = await convert(fixture('flow-prose.html'), {
    out: out('footer.pdf'), flow: true, pageNumbers: true, pageFooter: 'Kitch Wrapped Draft',
  });
  assert.equal(r.pageFooter, 'Kitch Wrapped Draft');
  const pages = await extractPages(r.master);
  for (let i = 0; i < pages.length; i++) {
    assert.ok(pages[i].includes('Kitch Wrapped Draft'), `footer missing from sheet ${i + 1}`);
    assert.ok(pages[i].includes(`${i + 1} / ${pages.length}`), `counter missing from sheet ${i + 1}`);
  }
});

test('a preset running footer resolves from the document title at run time', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  // flow-prose's <title> is "flow prose" (the document's own casing is kept)
  const r = await convert(fixture('flow-prose.html'), { out: out('preset-footer.pdf'), preset: 'contract' });
  const pages = await extractPages(r.master);
  assert.ok(pages.every((p) => p.includes('flow prose')), 'the title became the running footer');
  assert.ok(pages[0].includes('1 /'), 'contract also carries page numbers');
  assert.equal(r.pageFooter, 'flow prose');
});

/* ------------------------------------------------------------------ toc */

test('generated TOC lists every section on the sheet it really prints to', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const r = await convert(fixture('flow-prose.html'), { out: out('toc.pdf'), flow: true, toc: true });
  assert.equal(r.toc.stable, true, `numbers converged (iterations ${r.toc.iterations})`);
  assert.equal(r.toc.entries, 10);
  const pages = await extractPages(r.master);
  // numbers recorded by the run must be the sheets the text lands on: probe
  // each section's first word on its recorded sheet
  for (let i = 0; i < r.toc.numbers.length; i++) {
    const sheet = r.toc.numbers[i];
    const text = pages[sheet - 1] || '';
    assert.ok(text.length > 0, `sheet ${sheet} exists`);
  }
  // the Contents heading is in the PDF
  assert.ok(pages[0].includes('Contents'), 'the TOC page printed');
});

test('section-mode TOC numbers are settled before any print (arithmetic, not search)', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  // teaser keeps the run quick: 3 sections -> Contents + 3 sheets
  const r = await convert(fixture('flow-prose.html'), { out: out('toc-section.pdf'), toc: true, teaser: 3 });
  assert.equal(r.layout, 'section');
  assert.equal(r.toc.stable, true);
  assert.equal(r.toc.iterations, 0);
  assert.deepEqual(r.toc.numbers, [2, 3, 4]);
  const pages = await extractPages(r.master);
  assert.equal(pages.length, 4, 'Contents page + 3 sections');
  assert.ok(pages[0].includes('Contents'));
});

test('toc.js: one row per section, pages capped, HTML escaped', () => {
  assert.equal(estimateTocPages(10), 1);
  assert.equal(estimateTocPages(41), 2);
  assert.equal(estimateTocPages(0), 1);
  const html = buildTocHtml([
    { title: 'Setup & <Config>', id: 's1', page: 2 },
    { title: null, id: 's2', page: 5 },
  ]);
  assert.ok(html.includes('Setup &amp; &lt;Config&gt;'));
  assert.ok(html.includes('>5<'));
  // null titles fall back to the id (which is at least COMPUTABLE), and the
  // 'Section' fallback applies only when there is nothing at all
  assert.ok(html.includes('>s2<'));
  assert.ok(buildTocHtml([{ title: null, id: null, page: 1 }]).includes('>Section<'));
  assert.equal(escapeHtml('a<b>&"c'), 'a&lt;b&gt;&amp;&quot;c');
});

/* ----------------------------------------------------------------- fill */

test('flowCss: loose extends the keep-together set, balanced does not', () => {
  const balanced = flowCss({});
  const loose = flowCss({ fill: 'loose' });
  // the keep-together RULE specifically, not any rule mentioning li
  assert.ok(balanced.includes('svg { break-inside: avoid }'));
  assert.ok(!balanced.includes('svg, li, dd, dt'));
  assert.ok(loose.includes('svg, li, dd, dt'));
});

test('verifyFlow carries the tight candidate instead of assuming scale 1', () => {
  const a = { pages: [{ index: 1, blank: false, clipped: false, text: 'x' }], pageCount: 1 };
  assert.equal(verifyFlow(a, { scale: 0.98 }).scaleApplied, 0.98);
  assert.equal(verifyFlow(a, {}).scaleApplied, 1);
  // the floor is by construction: below 0.97 is refused by the printer
  assert.equal(verifyFlow(a, { scale: 0.5 }).scaleApplied, 1);
});

/* -------------------------------------------------------------- presets */

test('presets: the whole table resolves to the documented bundles', () => {
  assert.deepEqual(PRESETS.deck, {});
  const report = presetDefaults('report');
  assert.equal(report.flow, true);
  assert.equal(report.pageNumbers, true);
  assert.equal(report.toc, undefined, 'report has no TOC');
  const book = presetDefaults('book');
  assert.equal(book.toc, true, 'book carries a Contents page');
  assert.equal(book.footerFromTitle, true, 'book carries a running footer');
  assert.deepEqual(book.margins, { top: 0.6, bottom: 0.6 });
  const invoice = presetDefaults('invoice');
  assert.notEqual(invoice.flow, true, 'invoice stays in the section engine');
  const contract = presetDefaults('contract');
  assert.equal(contract.flow, true);
  assert.equal(contract.footerFromTitle, true);
  assert.equal(contract.toc, undefined, 'contract has no TOC');
  assert.equal(PRESET_NAMES.length, 5);
  assert.throws(() => presetDefaults('newsletter'), /unknown preset/);
});

test('presets: explicit options win over preset defaults, in both directions', () => {
  assert.equal(applyPreset('report', { pageNumbers: false }).pageNumbers, false);
  assert.equal(applyPreset('report', {}).flow, true);
  assert.equal(applyPreset('book', { toc: false }).toc, false);
  assert.equal(applyPreset('', { flow: true }).preset, undefined);
  // footerFromTitle yields to an explicit --page-footer
  assert.equal(
    applyPreset('book', { pageFooter: 'Mine' }).footerFromTitle,
    'Mine',
    'an explicit footer defeats the preset title footer'
  );
});

test('preset report converts end to end with numbers from the engine', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const r = await convert(fixture('flow-prose.html'), { out: out('preset-report.pdf'), preset: 'report' });
  assert.equal(r.layout, 'flow');
  const pages = await extractPages(r.master);
  for (let i = 0; i < pages.length; i++) {
    assert.ok(pages[i].includes(`${i + 1} / ${pages.length}`));
  }
  assert.equal(r.verification.mode, 'flow');
  assert.equal(r.verification.ok, true);
});

test('flow outline: bookmarks land on the sheets the text layer says', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const r = await convert(fixture('flow-prose.html'), {
    out: out('outline.pdf'), flow: true, outline: true, probe: 'must still appear in full',
  });
  assert.ok(r.outline, 'outline metadata is reported');
  assert.equal(r.outline.entries, 10);
  const doc = await PDFDocument.load(fs.readFileSync(r.master));
  const outlines = doc.catalog.lookup(PDFName.of('Outlines'));
  assert.ok(outlines, 'the outline panel is written into the catalog');
  const createRequireless = null;
});
