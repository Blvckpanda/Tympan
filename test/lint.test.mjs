/**
 * lint.test.mjs — the rule set, and the wiring that feeds it.
 *
 * The rules are pure, so almost everything here runs without Chromium and
 * asserts on exact findings (rule, severity, page) rather than on "something
 * happened". The one browser test exists because the rules are only useful if
 * the measurements they run on are real: it converts a document that is
 * genuinely broken in the three ways lint claims to catch — a local image the
 * security gate refuses, a sparse page, a page that ends on its own heading —
 * and checks that lint names them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  lintDocument,
  summarizeLint,
  failureReport,
  lintExitCode,
  formatLintReport,
  shortSrc,
  SCALE_WARN,
  FLOW_MIN_FILL,
} from '../src/lint.js';
import { convert } from '../src/index.js';
import { buildJsonReport } from '../src/report.js';
import { findChromium } from '../src/browser.js';

/** A judged page record with sane defaults, overridden per test. */
const page = (over = {}) => ({
  index: 1,
  sectionId: 'section-1',
  contentHeightPx: 990,
  usableHeightPx: 1045,
  blankTailPx: 55,
  fillRatio: 0.95,
  scaleApplied: 1,
  widthScale: 1,
  scaledFor: 'none',
  underfilled: false,
  strandedHeading: false,
  keptTogether: true,
  lastBlockKind: 'text',
  ...over,
});

/** A4 portrait geometry, the CLI defaults. */
const GEO = {
  W_IN: 8.27,
  H_IN: 11.69,
  contentW: 774,
  margins: { top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 },
};

const rules = (report) => report.findings.map((f) => f.rule);
const byRule = (report, rule) => report.findings.filter((f) => f.rule === rule);

test('lint: a full document with no hazards is clean and exits 0', () => {
  const r = lintDocument({
    input: 'clean.html',
    pages: [page({ index: 1 }), page({ index: 2, sectionId: 'section-2' })],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  assert.deepEqual(r.findings, []);
  assert.equal(r.ok, true);
  assert.equal(r.errors + r.warnings + r.notes, 0);
  assert.equal(lintExitCode([r]), 0);
  assert.match(formatLintReport([r]), /^\[ok\] clean\.html\n.*0 error\(s\), 0 warning\(s\), 1 clean$/m);
});

test('lint: a sparse page is a warning naming the page and the blank tail', () => {
  const r = lintDocument({
    input: 'sparse.html',
    pages: [page({ index: 3, fillRatio: 0.12, blankTailPx: 919 })],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  const hit = byRule(r, 'page-underfilled');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].severity, 'warning');
  assert.equal(hit[0].page, 3);
  assert.equal(hit[0].blankTailPx, 919);
  assert.match(hit[0].message, /page 3 is 12% full/);
  // A sparse page is a finding, not a defect: it must not fail the run.
  assert.equal(r.ok, true);
  assert.equal(lintExitCode([r]), 0);
  assert.equal(lintExitCode([r], { strict: true }), 1);
});

test('lint: targetFill moves the line a page is judged against', () => {
  const ctx = {
    pages: [page({ fillRatio: 0.75 })],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  };
  assert.equal(byRule(lintDocument(ctx), 'page-underfilled').length, 0);
  assert.equal(byRule(lintDocument({ ...ctx, targetFill: 0.8 }), 'page-underfilled').length, 1);
  // 0 is "never flag": a deliberately sparse full-bleed deck needs a way out.
  assert.equal(byRule(lintDocument({ ...ctx, targetFill: 0 }), 'page-underfilled').length, 0);
  assert.equal(
    byRule(lintDocument({ ...ctx, pages: [page({ fillRatio: 0.02 })], targetFill: 0 }), 'page-underfilled').length,
    0
  );
});

test('lint: a page that ends on a heading is reported as stranded', () => {
  const r = lintDocument({
    pages: [page({ index: 2, strandedHeading: true, lastBlockKind: 'heading' })],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  const hit = byRule(r, 'stranded-heading');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].page, 2);
  assert.match(hit[0].message, /ends on a heading/);
});

test('lint: a split keep-together block is reported', () => {
  const r = lintDocument({
    pages: [page({ index: 4, keptTogether: false })],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  assert.equal(byRule(r, 'split-keep-together').length, 1);
  assert.equal(byRule(r, 'split-keep-together')[0].page, 4);
});

test('lint: a shrink is a note when mild and a warning when visible', () => {
  const mild = lintDocument({
    pages: [page({ scaleApplied: 0.97, scaledFor: 'height' })],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  assert.equal(byRule(mild, 'page-scaled')[0].severity, 'note');
  assert.equal(lintExitCode([mild], { strict: true }), 1);

  const ugly = lintDocument({
    pages: [page({ scaleApplied: SCALE_WARN - 0.05, scaledFor: 'height' })],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  assert.equal(byRule(ugly, 'page-scaled')[0].severity, 'warning');
});

test('lint: a document-wide width shrink is one finding, not one per page', () => {
  // Exactly the Kitch deck's shape: every page at 0.902 because the layout is
  // wider than the column, no section too tall.
  const r = lintDocument({
    pages: [
      page({ index: 1, scaleApplied: 0.902, widthScale: 0.902, scaledFor: 'width' }),
      page({ index: 2, scaleApplied: 0.902, widthScale: 0.902, scaledFor: 'width' }),
    ],
    geometry: GEO,
    layoutWidthPx: 774,
  });
  assert.equal(byRule(r, 'page-scaled').length, 0, 'the height bound did not shrink anything');
  assert.equal(byRule(r, 'column-narrower-than-layout').length, 1);
  assert.equal(byRule(r, 'content-overflow').length, 0, 'no page is worse than the document baseline');
  assert.equal(r.warnings, 1, JSON.stringify(r.findings));
});

test('lint: a page whose own content is wider than the column is named', () => {
  const r = lintDocument({
    pages: [
      page({ index: 1, scaleApplied: 0.902, widthScale: 0.902, scaledFor: 'width' }),
      page({ index: 2, scaleApplied: 0.71, widthScale: 0.71, scaledFor: 'width' }),
    ],
    geometry: GEO,
    layoutWidthPx: 774,
  });
  const hit = byRule(r, 'content-overflow');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].page, 2);
  assert.match(hit[0].message, /71%/);
});

test('lint: pages that disagree on type size are reported once, not per page', () => {
  const spread = lintDocument({
    pages: [
      page({ index: 1, scaleApplied: 0.7, scaledFor: 'height' }),
      page({ index: 2, scaleApplied: 0.95, scaledFor: 'height' }),
    ],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  const hit = byRule(spread, 'inconsistent-scale');
  assert.equal(hit.length, 1, 'one document-level finding');
  assert.deepEqual(hit[0].scales, [0.7, 0.95]);
  assert.match(hit[0].message, /70%–95%/);

  const consistent = lintDocument({
    pages: [
      page({ index: 1, scaleApplied: 0.94, scaledFor: 'height' }),
      page({ index: 2, scaleApplied: 0.95, scaledFor: 'height' }),
    ],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  assert.equal(byRule(consistent, 'inconsistent-scale').length, 0, '0.01 apart is not a type-size problem');
});

test('lint: the layout/column mismatch is measured from geometry, not guessed', () => {
  const r = lintDocument({
    pages: [page()],
    geometry: GEO, // 8.27in - 1.0in of side margins = 697.9px column
    layoutWidthPx: 774,
  });
  const hit = byRule(r, 'column-narrower-than-layout');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].columnWidthPx, 698);
  assert.equal(hit[0].layoutWidthPx, 774);
  assert.equal(hit[0].hint.includes('698px'), true);
  assert.match(hit[0].message, /90%/);

  // Aligned (a caller who has set contentWidth/margins to match) is silent.
  const aligned = lintDocument({ pages: [page()], geometry: GEO, layoutWidthPx: 698 });
  assert.equal(byRule(aligned, 'column-narrower-than-layout').length, 0);
});

test('lint: a lost image is an error, and the source list is the fallback', () => {
  const fromPrint = lintDocument({
    pages: [page()],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
    audit: { brokenImages: [{ src: '/assets/logo.png', alt: 'logo', page: 2 }] },
  });
  const hit = byRule(fromPrint, 'broken-asset');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].severity, 'error');
  assert.equal(hit[0].page, 2);
  assert.equal(fromPrint.ok, false);
  assert.equal(lintExitCode([fromPrint]), 1, 'errors fail without --strict');
  assert.match(formatLintReport([fromPrint]), /^\[FAIL\] /m);

  // Sections can drop the reference before it fails a second time; the source
  // page's own list is then all the evidence there is.
  const fromSource = lintDocument({
    pages: [page()],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
    audit: { brokenImages: [], sourceBrokenImages: [{ src: 'logo.png' }] },
  });
  assert.equal(byRule(fromSource, 'broken-asset').length, 1);
  assert.equal(fromSource.errors, 1);
});

test('lint: many lost images are capped, with a final count', () => {
  const brokenImages = Array.from({ length: 20 }, (_, i) => ({ src: `img${i}.png`, page: 1 }));
  const r = lintDocument({
    pages: [page()],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
    audit: { brokenImages },
  });
  const hit = byRule(r, 'broken-asset');
  assert.equal(hit.length, 9, '8 named plus one count');
  assert.match(hit[8].message, /and 12 more image/);
  assert.equal(r.errors, 9);
});

test('lint: blocked requests are grouped by reason with an example', () => {
  const r = lintDocument({
    pages: [page()],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
    audit: {
      blockedRequests: [
        { url: 'file:///C:/docs/logo.png', reason: 'file:// read' },
        { url: 'file:///C:/docs/hero.png', reason: 'file:// read' },
        { url: 'http://169.254.169.254/latest/meta-data', reason: 'private/metadata network' },
      ],
    },
  });
  const hit = byRule(r, 'blocked-request');
  assert.equal(hit.length, 2, 'one finding per reason, not per request');
  const file = hit.find((h) => h.reason === 'file:// read');
  assert.equal(file.count, 2);
  assert.equal(file.severity, 'warning');
  assert.match(file.message, /logo\.png/);
});

test('lint: the source carrying its own print CSS is a note, not a defect', () => {
  const r = lintDocument({
    pages: [page()],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
    audit: { printCss: { mediaPrint: 2, pageRules: 1, sheets: 1, unreadableSheets: 0 } },
  });
  const hit = byRule(r, 'print-css-in-source');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].severity, 'note');
  assert.equal(hit[0].mediaPrint, 2);
  assert.equal(r.ok, true);
  assert.equal(lintExitCode([r]), 0);

  const none = lintDocument({
    pages: [page()],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
    audit: { printCss: { mediaPrint: 0, pageRules: 0, sheets: 1, unreadableSheets: 0 } },
  });
  assert.equal(byRule(none, 'print-css-in-source').length, 0);
});

test('lint: fixed-position and viewport-sized blocks are named', () => {
  const r = lintDocument({
    pages: [page()],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
    audit: { fixedElements: ['header#top'], viewportClamps: ['section.hero', 'div.band'] },
  });
  assert.equal(byRule(r, 'fixed-position')[0].count, 1);
  assert.equal(byRule(r, 'viewport-clamp')[0].count, 2);
  assert.equal(r.warnings, 2);
});

test('lint: no pages at all is an error', () => {
  // Aligned column: this test is about the page count, not the geometry.
  const r = lintDocument({
    input: 'empty.html',
    pages: [],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  assert.deepEqual(rules(r), ['no-pages']);
  assert.equal(r.ok, false);
  assert.equal(lintExitCode([r]), 1);
});

test('lint: an unconvertible document still appears in the report', () => {
  const r = failureReport('broken.html', 'SPILL PAGES');
  assert.equal(r.input, 'broken.html');
  assert.equal(r.errors, 1);
  assert.equal(r.findings[0].rule, 'conversion-failed');
  assert.match(r.findings[0].message, /SPILL PAGES/);
  const empty = lintDocument({
    pages: [],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  const s = summarizeLint([r, empty]);
  assert.deepEqual(s, { errors: 2, warnings: 0, notes: 0, ok: false });
});

test('lint: the human report is ordered by severity and totals every document', () => {
  const r = lintDocument({
    input: 'doc.html',
    pages: [page({ index: 2, fillRatio: 0.2, blankTailPx: 800, strandedHeading: true })],
    geometry: GEO,
    layoutWidthPx: 774,
    audit: { printCss: { mediaPrint: 1, pageRules: 0 } },
  });
  const text = formatLintReport([r]);
  const order = ['page-underfilled', 'stranded-heading', 'column-narrower-than-layout', 'print-css-in-source'];
  const positions = order.map((rule) => text.indexOf(rule));
  assert.ok(positions.every((p) => p >= 0), text);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'warnings before notes');
  assert.match(text, /tympan lint: 1 document\(s\), 0 error\(s\), 3 warning\(s\)/);
});

test('lint: shortSrc keeps a terminal line bounded', () => {
  assert.equal(shortSrc('logo.png'), 'logo.png');
  const long = 'https://example.com/' + 'a'.repeat(200) + '.png';
  assert.equal(shortSrc(long).length, 64);
  assert.match(shortSrc(long), /^\.\.\./);
});

/* ----------------------------------------------------------- flow rules */

/** A judged flow page record: PDF-measured, no section identity. */
const flowPage = (over = {}) => ({
  ...page(over),
  measuredFrom: 'pdf',
  sectionId: null,
  ...over,
});

test('lint flow: a page below the 10% floor is flagged as a remnant sheet', () => {
  const r = lintDocument({
    input: 'prose.html',
    layout: 'flow',
    pages: [
      flowPage({ index: 1, fillRatio: 0.81, blankTailPx: 199 }),
      flowPage({ index: 2, fillRatio: 0.04, blankTailPx: 1003 }),
    ],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  const hit = byRule(r, 'flow-near-empty');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].severity, 'warning');
  assert.equal(hit[0].page, 2);
  assert.equal(hit[0].fillRatio, 0.04);
  assert.match(hit[0].message, /page 2 is 4% full/);
  assert.match(hit[0].message, /10% flow floor/);

  // The boundary is strict: at exactly 10% the page is not a remnant.
  const at = lintDocument({
    layout: 'flow',
    pages: [flowPage({ index: 1, fillRatio: FLOW_MIN_FILL, blankTailPx: 940 })],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  assert.equal(byRule(at, 'flow-near-empty').length, 0, '10% is the floor, not below it');

  // Round-off never claims the floor was met: 0.099 displays as 9%, not the
  // self-contradicting "10% full — below the 10% flow floor" a round() gave.
  const justBelow = lintDocument({
    layout: 'flow',
    pages: [flowPage({ index: 6, fillRatio: 0.099, blankTailPx: 941 })],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  const justHit = byRule(justBelow, 'flow-near-empty')[0];
  assert.ok(justHit, '0.099 is below the floor');
  assert.match(justHit.message, /page 6 is 9% full/);
  assert.doesNotMatch(justHit.message, /10% full/);
});

test('lint flow: the 10% floor holds even when targetFill is 0 (a sparse page is no exoneration)', () => {
  const r = lintDocument({
    layout: 'flow',
    targetFill: 0,
    pages: [flowPage({ index: 3, fillRatio: 0.05, blankTailPx: 993 })],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  assert.deepEqual(rules(r), ['flow-near-empty']);
});

test('lint flow: a stranded heading is flagged once, by the flow rule', () => {
  const r = lintDocument({
    layout: 'flow',
    pages: [flowPage({ index: 2, fillRatio: 0.22, lastBlockKind: 'heading' })],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  const hit = byRule(r, 'flow-stranded-heading');
  assert.equal(hit.length, 1, JSON.stringify(r.findings));
  assert.equal(hit[0].severity, 'warning');
  assert.equal(hit[0].page, 2);
  assert.equal(hit[0].measuredFrom, 'pdf');
  assert.match(hit[0].message, /heading-sized text \(PDF text layer\)/);
  // No duplicate: the section rule stays quiet on flow output.
  assert.deepEqual(byRule(r, 'stranded-heading'), []);
});

test('lint flow: fill counts as the PDF measured it, and a remnant page names the cause, not a style choice', () => {
  // fillRatio/blankTailPx carried straight from the judged record: lint is a
  // reporter, not a re-measurer.
  const r = lintDocument({
    layout: 'flow',
    pages: [flowPage({ index: 5, fillRatio: 0.09, blankTailPx: 951 })],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  assert.match(byRule(r, 'flow-near-empty')[0].message, /951px/);
  assert.match(byRule(r, 'flow-near-empty')[0].message, /widow or an unbreakable block/);
});

test('lint flow: a well-filled flow document is clean under the flow rules', () => {
  const r = lintDocument({
    layout: 'flow',
    pages: [
      flowPage({ index: 1, fillRatio: 0.81 }),
      flowPage({ index: 2, fillRatio: 0.79, blankTailPx: 219 }),
      flowPage({ index: 3, fillRatio: 0.62, blankTailPx: 397 }), // under 0.7, over the floor
    ],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  assert.deepEqual(r.findings, [], 'a 62% page is what flow mode produced; it is not a section that failed to fill its only sheet');
  assert.equal(lintExitCode([r], { strict: true }), 0);
});

test('lint flow: the same records judged as section output keep the section rules', () => {
  // Without the flow gate, these are section pages: 62% and 9% fill are
  // page-underfilled, a heading tail is stranded-heading — as before.
  const r = lintDocument({
    pages: [
      page({ index: 1, fillRatio: 0.62, blankTailPx: 397 }),
      page({ index: 2, fillRatio: 0.09, blankTailPx: 951 }),
      page({ index: 3, strandedHeading: true, lastBlockKind: 'heading' }),
    ],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  assert.equal(byRule(r, 'page-underfilled').length, 2);
  assert.equal(byRule(r, 'stranded-heading').length, 1);
  assert.equal(byRule(r, 'flow-near-empty').length, 0);
  assert.equal(byRule(r, 'flow-stranded-heading').length, 0);
});

test('lint flow: the mode is inferred from PDF-measured pages when layout is not given', () => {
  // What a caller that passes convert()'s result through gets when it forgets
  // to set layout: the pipeline stamps flow pages measuredFrom: 'pdf'.
  const inferred = lintDocument({
    pages: [flowPage({ index: 3, fillRatio: 0.05, blankTailPx: 993 })],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  assert.equal(byRule(inferred, 'flow-near-empty').length, 1);
  // Explicit 'section' beats the stamp: a caller who knows better wins.
  const explicit = lintDocument({
    layout: 'section',
    pages: [flowPage({ index: 3, fillRatio: 0.05, blankTailPx: 993 })],
    geometry: { ...GEO, contentW: 698 },
    layoutWidthPx: 698,
  });
  assert.equal(byRule(explicit, 'flow-near-empty').length, 0);
  assert.equal(byRule(explicit, 'page-underfilled').length, 1);
});

/* ------------------------------------------------------- end to end ---- */

// A document that genuinely strands a heading in flow mode: the heading is a
// real `h2` near the bottom of sheet 1, and the section it introduces forces a
// page break of its own (`break-before: page` — the standard "section starts
// on a fresh sheet" authoring, which OVERRIDES the flow template's
// `break-after: avoid` on headings; an unbreakable block alone does not,
// because Chromium honors the avoid and moves the heading with the block).
const STRANDED_DOC = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>stranded heading</title>
<style>
  html,body{margin:0}
  main{max-width:774px;margin:0 auto;font:16px/1.6 system-ui}
  .lead{height:780px}
  .force{break-before:page}
</style></head>
<body><main>
  <p>Prose before the heading so the heading lands near the bottom of the
  first sheet.</p>
  <div class="lead">Filler paragraph filler paragraph filler paragraph
  filler paragraph filler paragraph filler paragraph.</div>
  <h2>Schedule of fees</h2>
  <div class="force">
    <p>The following schedule applies to every lot in this release. It opens
    on its own sheet by this document's own design, so the heading that
    introduces it is left behind on the sheet before.</p>
    <p>Lot one carries the standard charge and lot two the reduced charge for
    early settlement, recorded against the next financial year, until the
    account passes ninety days from issue.</p>
    <p>Charges are recalculated whenever the underlying assessment changes,
    and any recalculated amount is notified in writing within fourteen days
    of the change taking effect.</p>
    <p>Where a lot spans more than one release, the applicable schedule is
    the one in force on the date the whole lot was first committed.</p>
    <p>Discounts recorded against a lot survive the amendment of the schedule
    that granted them, unless the recording document says otherwise.</p>
  </div>
</main></body></html>`;

test('lint flow: a stranded heading fires end to end, through the real conversion', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-strand-'));
  const src = path.join(dir, 'stranded.html');
  fs.writeFileSync(src, STRANDED_DOC);
  try {
    const result = await convert(src, { flow: true, out: path.join(dir, 'stranded.pdf'), verify: false });
    assert.ok(result.flow, 'the document converted in flow mode');
    assert.equal(result.pages.length, 2, `expected one go sheet and one pushed sheet, got ${result.pages.length}`);
    // The measurement closed the loop before lint runs: the PDF text layer
    // sees the heading as the last text of sheet 1.
    const strandedPages = result.verification?.strandedHeadingPages ?? [];
    assert.deepStrictEqual(strandedPages, [1], JSON.stringify(result.pages, null, 2));
    const report = lintDocument({
      input: 'stranded.html',
      layout: 'flow',
      pages: result.pages,
      quality: result.quality,
      geometry: { ...GEO, contentW: 698 },
      layoutWidthPx: result.contentMaxWidth,
    });
    const hit = byRule(report, 'flow-stranded-heading');
    assert.equal(hit.length, 1, JSON.stringify(report.findings, null, 2));
    assert.equal(hit[0].page, 1);
    assert.equal(hit[0].measuredFrom, 'pdf');
    // The pushed sheet stays out of the section rules' jurisdiction: 20-ish
    // percent of a shared sheet is flow's own fill, not an underfilled page.
    assert.deepEqual(byRule(report, 'stranded-heading'), [], 'the section rule stays quiet on flow output');
    assert.deepEqual(byRule(report, 'page-underfilled'), [], 'a shared sheet is not judged against the 0.7 section target');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const BROKEN_DOC = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>lint fixture</title>
<style>
  html,body{margin:0}
  main{max-width:774px;margin:0 auto}
  @media print { section { break-after: page } } /* hostile print CSS */
</style></head>
<body><main>
  <section class="page-section" id="sparse"><p>One short line.</p></section>
  <section class="page-section" id="heading-only"><h2>Nothing follows</h2></section>
  <section class="page-section" id="image"><h3>Figure</h3><img src="missing-logo.png" alt="logo"></section>
</main></body></html>`;

test('lint: end to end, the findings describe the converted document', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-lint-'));
  const src = path.join(dir, 'lint-input.html');
  fs.writeFileSync(src, BROKEN_DOC);
  try {
    const result = await convert(src, { out: path.join(dir, 'lint-input.pdf'), verify: false });

    // The audit travels on the result and reaches --json.
    assert.ok(result.audit, 'audit recorded');
    assert.ok(result.audit.printCss.mediaPrint >= 1, 'the @media print block was seen via the CSSOM');
    assert.ok(Array.isArray(result.audit.blockedRequests), 'blocked requests are a list of reasons');
    const named = result.audit.brokenImages.filter((b) => /missing-logo/.test(b.src));
    assert.ok(named.length >= 1, `expected the missing image, got ${JSON.stringify(result.audit.brokenImages)}`);
    assert.ok(named.every((b) => typeof b.page === 'number' && b.page >= 1), 'broken images carry a page');
    const json = buildJsonReport(result, { input: 'lint-input.html' });
    assert.equal(json.audit.brokenImages.length, result.audit.brokenImages.length);

    const report = lintDocument({
      input: 'lint-input.html',
      pages: result.pages,
      quality: result.quality,
      geometry: {
        W_IN: 8.27,
        H_IN: 11.69,
        contentW: 774,
        margins: { top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 },
      },
      layoutWidthPx: result.contentMaxWidth,
      audit: result.audit,
    });

    assert.ok(byRule(report, 'broken-asset').length >= 1, JSON.stringify(report.findings, null, 2));
    assert.ok(byRule(report, 'page-underfilled').length >= 2, 'the sparse and heading-only sheets');
    assert.ok(byRule(report, 'stranded-heading').length >= 1);
    assert.ok(byRule(report, 'print-css-in-source').length >= 1);
    assert.equal(report.ok, false, 'a lost image fails the run');
    assert.equal(lintExitCode([report]), 1);
    assert.equal(report.quality.pages, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
