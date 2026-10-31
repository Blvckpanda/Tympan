/**
 * metrics.test.mjs — unit tests for the page-quality math (src/metrics.js).
 *
 * The regression this pins is a measurement bug, not a rendering bug: an
 * earlier audit graded a four-page Kitch deliverable as "0% wasted space" by
 * reading ink coverage off the rendered PDF, on a document that paints its
 * page background full-bleed. Coarse coverage cannot see a sparse page when
 * every pixel is beige. These tests require the metric to come from DOM
 * content height against the usable text area, so the same document is
 * reported as roughly one-third full.
 *
 * Hermetic: no browser, no PDFs, no I/O.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TARGET_FILL,
  fillRatio,
  blankTailPx,
  judgePage,
  summarizeQuality,
  formatQualityLine,
} from '../src/metrics.js';
import { resolveGeometry } from '../src/pipeline.js';

/** A4 portrait, the v0.5 default: usable text area in CSS px. */
const A4_PORTRAIT_USABLE =
  (resolveGeometry({}).H_IN - resolveGeometry({}).margins.top - resolveGeometry({}).margins.bottom) * 96;

test('fillRatio: content height over usable height', () => {
  assert.equal(fillRatio(500, 1000), 0.5);
  assert.equal(fillRatio(1000, 1000), 1);
  assert.equal(fillRatio(0, 1000), 0);
});

test('fillRatio: clamps instead of returning nonsense', () => {
  assert.equal(fillRatio(4000, 1000), 1, 'taller than the page is still 100%, never more');
  assert.equal(fillRatio(-50, 1000), 0, 'a negative measurement cannot go below empty');
  assert.equal(fillRatio(500, 0), 0, 'no usable area is 0, not Infinity');
  assert.equal(fillRatio(500, -10), 0);
  assert.equal(fillRatio('abc', 1000), 0, 'garbage in, 0 out — this number reaches CI');
  assert.equal(fillRatio(500, 'abc'), 0);
});

test('blankTailPx: the space left at the bottom, clamped at zero', () => {
  assert.equal(blankTailPx(300, 1000), 700);
  assert.equal(blankTailPx(1000, 1000), 0);
  assert.equal(blankTailPx(1400, 1000), 0, 'overflow has no blank tail, it has a spill problem');
});

test('judgePage: reports a sparse page as sparse', () => {
  const p = judgePage({ index: 2, sectionId: 'sec-2', contentHeightPx: 300, usableHeightPx: 1000 });
  assert.equal(p.fillRatio, 0.3);
  assert.equal(p.blankTailPx, 700);
  assert.equal(p.underfilled, true);
  assert.equal(p.scaleApplied, 1, 'nothing shrank');
  // A sparse page must not IMPLY a split — and since the tri-state change it
  // must not imply the opposite either: an omitted measurement stays `null`
  // (unmeasured). Section and preview callers pass `true` explicitly.
  assert.equal(p.keptTogether, null, 'no split was reported, and none invented');
  assert.equal(judgePage({ contentHeightPx: 300, usableHeightPx: 1000, keptTogether: true }).keptTogether, true);
  assert.equal(p.strandedHeading, false);
});

test('judgePage: the target is exclusive, so a page exactly at it passes', () => {
  assert.equal(judgePage({ contentHeightPx: 700, usableHeightPx: 1000 }).underfilled, false);
  assert.equal(judgePage({ contentHeightPx: 699, usableHeightPx: 1000 }).underfilled, true);
  assert.equal(TARGET_FILL, 0.7);
});

test('judgePage: a heading as the last block is a stranded heading', () => {
  const heading = judgePage({ contentHeightPx: 500, usableHeightPx: 1000, lastBlockKind: 'heading' });
  assert.equal(heading.strandedHeading, true);
  assert.equal(heading.lastBlockKind, 'heading');
  assert.equal(judgePage({ contentHeightPx: 500, usableHeightPx: 1000, lastBlockKind: 'text' }).strandedHeading, false);
  assert.equal(judgePage({ contentHeightPx: 500, usableHeightPx: 1000, lastBlockKind: null }).strandedHeading, false);
});

test('judgePage: shrink and split keep-together are carried through, not swallowed', () => {
  const shrunk = judgePage({ contentHeightPx: 1200, usableHeightPx: 1000, scaleApplied: 0.81 });
  assert.equal(shrunk.scaleApplied, 0.81);
  assert.equal(shrunk.blankTailPx, 0, 'a shrunk page fits: no blank tail is implied by the raw measurement');
  assert.equal(judgePage({ contentHeightPx: 900, usableHeightPx: 1000, keptTogether: false }).keptTogether, false);
});

test('judgePage: rounds for stable JSON and stable test expectations', () => {
  const p = judgePage({ contentHeightPx: 333.3333, usableHeightPx: 1000 });
  assert.equal(p.contentHeightPx, 333);
  assert.equal(p.fillRatio, 0.333);
});

test('judgePage: flow mode leaves the 0.7 judgement unjudged (null); section keeps it', () => {
  const halfFull = { index: 2, contentHeightPx: 480, usableHeightPx: 1000 };
  // A caller that knows the run is flow: null (unjudged in this mode, the
  // same tri-state as keptTogether) — never a stale boolean judgement.
  assert.equal(judgePage(halfFull, { layout: 'flow' }).underfilled, null);
  // No layout / explicit section: the boolean, byte-identical to before.
  assert.equal(judgePage(halfFull).underfilled, true);
  assert.equal(judgePage(halfFull, { layout: 'section' }).underfilled, true);
});

test('summarizeQuality: empty input is all zeros, not NaN', () => {
  const s = summarizeQuality([]);
  assert.deepEqual(s.underfilledPages, []);
  assert.deepEqual(s.strandedHeadings, []);
  assert.deepEqual(s.splitKeepTogether, []);
  assert.deepEqual(s.shrunkPages, []);
  assert.equal(s.meanFill, 0);
  assert.equal(s.minFill, 0);
  assert.equal(s.pages, 0);
});

test('summarizeQuality: flow pages are not judged against the 0.7 section target', () => {
  // The same numbers: section mode flags the half-full sheet, flow mode stays
  // silent (its pages share sheets; the flow lint rules own the fill question).
  const pages = [
    { index: 1, contentHeightPx: 820, usableHeightPx: 1000, measuredFrom: 'pdf' },
    { index: 2, contentHeightPx: 480, usableHeightPx: 1000, measuredFrom: 'pdf' },
  ];
  const flow = summarizeQuality(pages);
  assert.deepEqual(flow.underfilledPages, [], 'inferred flow: 48% is what a shared sheet carried, not an underfilled page');
  const explicit = summarizeQuality(pages, { layout: 'flow' });
  assert.deepEqual(explicit.underfilledPages, []);
  // Same pages, told they are section output: the judgement returns.
  const section = summarizeQuality(pages, { layout: 'section' });
  assert.deepEqual(section.underfilledPages, [2]);
});

test('summarizeQuality: mean, min and the offending page numbers', () => {
  const s = summarizeQuality([
    { index: 1, contentHeightPx: 1000, usableHeightPx: 1000 },
    { index: 2, contentHeightPx: 500, usableHeightPx: 1000, lastBlockKind: 'heading' },
    { index: 3, contentHeightPx: 800, usableHeightPx: 1000, scaleApplied: 0.9, keptTogether: false },
  ]);
  assert.equal(s.pages, 3);
  assert.equal(s.meanFill, 0.767, '(1 + 0.5 + 0.8) / 3');
  assert.equal(s.minFill, 0.5);
  assert.deepEqual(s.underfilledPages, [2]);
  assert.deepEqual(s.strandedHeadings, [2]);
  assert.deepEqual(s.shrunkPages, [3]);
  assert.deepEqual(s.splitKeepTogether, [3]);
});

test('formatQualityLine: a clean document reports only its fill', () => {
  const line = formatQualityLine(summarizeQuality([{ index: 1, contentHeightPx: 900, usableHeightPx: 1000 }]));
  assert.equal(line, 'fill: mean 90%, min 90%');
});

test('formatQualityLine: names every finding it has, and none it does not', () => {
  const line = formatQualityLine(
    summarizeQuality([
      { index: 1, contentHeightPx: 300, usableHeightPx: 1000 },
      { index: 2, contentHeightPx: 900, usableHeightPx: 1000, lastBlockKind: 'heading', scaleApplied: 0.9 },
    ])
  );
  assert.match(line, /mean 60%, min 30%/);
  assert.match(line, /1 page\(s\) under 70%/);
  assert.match(line, /1 stranded heading\(s\)/);
  assert.match(line, /1 page\(s\) shrunk to fit/);
  assert.doesNotMatch(line, /split keep-together/, 'nothing split, so nothing is claimed');
});

test('regression: a full-bleed page is judged by its content, not its pixels', () => {
  // The Kitch pot-counter case: the sheet is painted edge to edge, so any
  // coverage-based metric scores it as full. One card on a portrait A4 sheet
  // is about a quarter of the text area.
  const p = judgePage({ index: 1, contentHeightPx: 300, usableHeightPx: A4_PORTRAIT_USABLE });
  assert.equal(Math.round(A4_PORTRAIT_USABLE), 1045, 'A4 portrait usable height stays 1045px');
  assert.equal(p.fillRatio, 0.287);
  assert.equal(p.underfilled, true);
  assert.equal(p.blankTailPx, 745);
});

test('judgePage: carries the last block kind, normalised', () => {
  const kind = (k) => judgePage({ contentHeightPx: 500, usableHeightPx: 1000, lastBlockKind: k });
  assert.equal(kind('HEADING').lastBlockKind, 'heading');
  assert.equal(kind('heading').strandedHeading, true);
  assert.equal(kind('table').lastBlockKind, 'table');
  assert.equal(kind('figure').lastBlockKind, 'figure');
  assert.equal(kind('text').lastBlockKind, 'text');
  assert.equal(kind(null).lastBlockKind, null);
  assert.equal(kind('banana').lastBlockKind, null, 'junk is not a kind');
  assert.equal(kind('banana').strandedHeading, false, 'junk cannot read as a stranded heading');
});

test('judgePage: a width-bound shrink and a too-tall section are told apart', () => {
  // The Kitch deck reading: a 774px layout printed into a 698px column puts
  // every page at 0.902 with no section being too tall. One number for both
  // cases turned one document-wide mismatch into nine per-page warnings.
  const widthBound = judgePage({ contentHeightPx: 700, usableHeightPx: 1045, scaleApplied: 0.902, widthScale: 0.902 });
  assert.equal(widthBound.scaledFor, 'width');
  assert.equal(widthBound.widthScale, 0.902);

  const tooTall = judgePage({ contentHeightPx: 1400, usableHeightPx: 1045, scaleApplied: 0.75, widthScale: 0.902 });
  assert.equal(tooTall.scaledFor, 'height', 'shrunk past what the width bound costs');

  assert.equal(judgePage({ contentHeightPx: 700, usableHeightPx: 1045 }).scaledFor, 'none');
  // A caller that predates widthScale keeps the old meaning: any shrink is
  // the height bound until told otherwise.
  assert.equal(judgePage({ contentHeightPx: 1400, usableHeightPx: 1045, scaleApplied: 0.7 }).scaledFor, 'height');
});

test('summarizeQuality: shrunkPages is height-bound, overflowPages is width-bound', () => {
  const s = summarizeQuality([
    { index: 1, contentHeightPx: 900, usableHeightPx: 1045, scaleApplied: 0.902, widthScale: 0.902 },
    { index: 2, contentHeightPx: 900, usableHeightPx: 1045, scaleApplied: 0.902, widthScale: 0.902 },
    { index: 3, contentHeightPx: 1500, usableHeightPx: 1045, scaleApplied: 0.6, widthScale: 0.902 },
  ]);
  assert.deepEqual(s.shrunkPages, [3]);
  assert.deepEqual(s.overflowPages, [1, 2]);
  const line = formatQualityLine(s);
  assert.match(line, /1 page\(s\) shrunk to fit/);
  assert.match(line, /2 page\(s\) wider than the column/);
});

test('the usable text area comes from the same geometry the pipeline prints at', () => {
  const landscape = resolveGeometry({ orientation: 'landscape' });
  const usable = (landscape.H_IN - landscape.margins.top - landscape.margins.bottom) * 96;
  assert.equal(Math.round(usable * 100) / 100, 717.12, 'spill.test.mjs reasons about this exact number');
  assert.equal(fillRatio(usable, usable), 1);
});
