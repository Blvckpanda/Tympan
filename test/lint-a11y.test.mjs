/**
 * lint-a11y.test.mjs — the accessibility half of `tympan lint`.
 *
 * Same split as lint.test.mjs: the rules are pure, so most of this file runs
 * without Chromium and asserts exact findings; the browser tests exist
 * because the audit is only useful if it is measured for real in the page —
 * one broken document (no lang, no-alt images, an unnamed control, text
 * under the 4.5:1 floor, a torn outline, an unnamed link, a headerless
 * table) exposes them end to end, and a clean deck stays silent when the
 * flag is off.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { a11yFindings, CONTRAST_NORMAL, CONTRAST_LARGE } from '../src/a11y.js';
import { lintDocument, lintExitCode } from '../src/lint.js';
import { convert } from '../src/index.js';
import { findChromium } from '../src/browser.js';

/** The audit a healthy document produces: every count zero, lang carried. */
const clean = (over = {}) => ({
  lang: 'en',
  h1Count: 1,
  headingTotal: 4,
  headingSkips: [],
  imageTotal: 3,
  missingAltCount: 0,
  missingAlt: [],
  controlTotal: 2,
  unlabeledCount: 0,
  unlabeled: [],
  linkTotal: 5,
  genericCount: 0,
  genericLinks: [],
  tableTotal: 2,
  headerlessCount: 0,
  headerlessTables: [],
  lowContrastCount: 0,
  lowestContrast: null,
  lowContrast: [],
  ...over,
});

test('a11y: constants match the WCAG floors they claim to be', () => {
  assert.equal(CONTRAST_NORMAL, 4.5);
  assert.equal(CONTRAST_LARGE, 3);
});

test('a11y: a clean audit produces no findings', () => {
  assert.deepEqual(a11yFindings(clean()), []);
});

test('a11y: a missing audit produces no findings either', () => {
  assert.deepEqual(a11yFindings(null), []);
  assert.deepEqual(a11yFindings(undefined), []);
});

test('a11y: a missing lang is a warning under a11y-html-lang', () => {
  const f = a11yFindings(clean({ lang: null }));
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'a11y-html-lang');
  assert.equal(f[0].severity, 'warning');
  assert.match(f[0].message, /WCAG 3\.1\.1/);
});

test('a11y: a missing alt attribute is the failure; an empty one is not', () => {
  // The audit only counts hasAttribute('alt') === false, so an empty alt
  // never reaches the rules; this asserts the shape it does arrive in.
  const f = a11yFindings(clean({ missingAltCount: 2, missingAlt: [{ src: 'a.png' }, { src: 'b.png' }] }));
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'a11y-img-alt');
  assert.equal(f[0].severity, 'warning');
  assert.match(f[0].message, /2 image\(s\)/);
  assert.match(f[0].message, /a\.png/);
  assert.match(f[0].message, /alt="" is fine/);
});

test('a11y: unnamed form controls are a warning naming one example', () => {
  const f = a11yFindings(clean({ unlabeledCount: 3, unlabeled: ['input#email', '.form-row input', 'select'] }));
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'a11y-form-label');
  assert.equal(f[0].severity, 'warning');
  assert.match(f[0].message, /3 form control/);
  assert.match(f[0].message, /input#email/);
});

test('a11y: the contrast finding names the lowest run and its own floor', () => {
  const f = a11yFindings(
    clean({ lowContrastCount: 4, lowestContrast: { describe: 'p.meta', ratio: 2.41, large: false } })
  );
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'a11y-contrast');
  assert.equal(f[0].severity, 'warning');
  assert.match(f[0].message, /4\.5:1/);
  assert.match(f[0].message, /p\.meta at 2\.41:1/);
  assert.match(f[0].message, /WCAG 1\.4\.3/);
  assert.equal(f[0].lowest, 2.41);
});

test('a11y: large type is judged by the 3:1 floor it earned', () => {
  const f = a11yFindings(
    clean({ lowContrastCount: 1, lowestContrast: { describe: 'h1.display', ratio: 2.9, large: true } })
  );
  assert.equal(f.length, 1);
  assert.match(f[0].message, /3:1/);
});

test('a11y: a torn outline is a note naming the jump', () => {
  const f = a11yFindings(clean({ headingSkips: [{ from: 'h1', to: 'h3' }] }));
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'a11y-heading-order');
  assert.equal(f[0].severity, 'note');
  assert.match(f[0].message, /h1 -> h3/);
});

test('a11y: one h1 is silent; zero and many are notes', () => {
  const zero = a11yFindings(clean({ h1Count: 0, headingTotal: 0 }));
  // headingTotal 0 is the no-headings case, not the missing-h1 case.
  assert.deepEqual(zero.map((f) => f.rule), ['a11y-no-headings']);
  const many = a11yFindings(clean({ h1Count: 3 }));
  assert.deepEqual(many.map((f) => f.rule), ['a11y-heading-count']);
  assert.match(many[0].message, /3 h1 elements/);
});

test('a11y: generic link text is a note with the first example', () => {
  const f = a11yFindings(clean({ genericCount: 2, genericLinks: [{ text: 'Click Here' }, { text: 'more' }] }));
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'a11y-generic-link');
  assert.equal(f[0].severity, 'note');
  assert.match(f[0].message, /2 link\(s\)/);
  assert.match(f[0].message, /click here/);
});

test('a11y: a headerless data table is a note naming the table', () => {
  const f = a11yFindings(clean({ headerlessCount: 1, headerlessTables: ['table.compare'] }));
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'a11y-table-headers');
  assert.equal(f[0].severity, 'note');
  assert.match(f[0].message, /table\.compare/);
});

test('a11y: the findings join a lint report and count as warnings', () => {
  const report = lintDocument({
    input: 'brief.html',
    pages: [{ index: 1, fillRatio: 0.95, blankTailPx: 30, sectionId: 's1' }],
    a11y: clean({ lang: null, missingAltCount: 1, missingAlt: [{ src: 'x.png' }] }),
  });
  const rules = report.findings.map((f) => f.rule);
  assert.deepEqual(rules, ['a11y-html-lang', 'a11y-img-alt']);
  assert.equal(report.warnings, 2);
  assert.equal(report.errors, 0);
  assert.equal(report.ok, true, 'a11y findings do not fail a run on their own');
});

test('a11y: with no audit in ctx, the report is unchanged by the rules', () => {
  const report = lintDocument({
    input: 'brief.html',
    pages: [{ index: 1, fillRatio: 0.95, blankTailPx: 30, sectionId: 's1' }],
  });
  assert.deepEqual(report.findings, []);
  // The JSON serializer tolerates missing a11y — buildJsonReport guards it.
});

const BAD_DOC = `<!doctype html><html><head><meta charset="utf-8">
<title>no a11y</title><style>
body{background:#ffffff;color:#cbc9b6;font-size:16px;margin:0;padding:40px}
.dim{color:#e0ddd2}
</style></head><body>
<section><h1>Cover</h1><p class="dim">Lorem plans et contracts.</p>
<section><h3>Detail</h3><p>More content follows here for the audit.</p></section>
<img src="hero.png">
<form><input type="text" name="date" value=""></form>
<p><a href="plan.pdf">click here</a></p>
<table><tr><td>plan</td><td>49</td></tr><tr><td>deck</td><td>59</td></tr></table>
</section></body></html>`;

test('a11y end to end: the real audit finds the broken document (opt-in)', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-a11y-'));
  const src = path.join(dir, 'a11y-broken.html');
  fs.writeFileSync(src, BAD_DOC);
  try {
    // The flag is opt-in on the conversion: without it, a11y stays null.
    const silent = await convert(src, { out: path.join(dir, 'off.pdf'), verify: false });
    assert.equal(silent.a11y, null, 'no --a11y, no extra walk: the result carries null');

    const result = await convert(src, { out: path.join(dir, 'on.pdf'), verify: false, auditA11y: true });
    const a = result.a11y;
    assert.ok(a, 'audit recorded');
    assert.equal(a.lang, null, 'no lang on html');
    assert.equal(a.missingAltCount, 1, 'the unlabeled img was counted');
    assert.equal(a.h1Count, 1, 'one h1');
    assert.deepEqual(a.headingSkips, [{ from: 'h1', to: 'h3' }], 'the torn outline');
    assert.ok(a.unlabeledCount >= 1, 'the unnamed input was counted');
    assert.ok(a.genericCount >= 1, 'the click-here link was counted');
    assert.equal(a.headerlessCount, 1, 'the th-less table was counted');
    assert.ok(a.lowContrastCount >= 1, `the dim text was counted: ${JSON.stringify(a)}`);
    assert.ok(a.lowestContrast.ratio < CONTRAST_NORMAL, `lowest below 4.5:1: ${JSON.stringify(a.lowestContrast)}`);

    const report = lintDocument({ input: 'a11y-broken.html', pages: result.pages, audit: result.audit, a11y: result.a11y });
    const rules = new Set(report.findings.map((f) => f.rule));
    for (const rule of ['a11y-html-lang', 'a11y-img-alt', 'a11y-heading-order', 'a11y-form-label', 'a11y-generic-link', 'a11y-table-headers', 'a11y-contrast']) {
      assert.ok(rules.has(rule), `expected ${rule}, got ${[...rules].join(', ')}`);
    }
    assert.equal(report.errors, 1, 'the one error is broken-asset: the fixture hero.png never exists');
    const a11yOnly = report.findings.filter((f) => f.rule.startsWith('a11y-'));
    assert.ok(a11yOnly.length >= 6, `the a11y rules spoke: ${a11yOnly.map((f) => f.rule).join(', ')}`);
    assert.ok(a11yOnly.every((f) => f.severity !== 'error'), 'the a11y findings are warnings/notes, not errors');
    assert.deepEqual(
      report.findings.filter((f) => f.severity === 'error').map((f) => f.rule),
      ['broken-asset'],
      'the error is broken-asset, not an a11y rule'
    );
    // --strict promotes the a11y warnings, exactly as it promotes lint's own.
    assert.equal(lintExitCode([report], { strict: true }), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a11y end to end: a healthy document stays clean with the flag on', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-a11y-'));
  const src = path.join(dir, 'a11y-clean.html');
  fs.writeFileSync(src, `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>clean</title><style>a{color:#8ab4ff}</style></head><body style="background:#101418;color:#f2f4f8;margin:0;padding:40px">
<section><h1>Tidy brief</h1><p>Contrast well above the floor everywhere.</p>
<section><h2>Second</h2><p>Sections follow the outline with no skips.</p></section>
<img src="chart.png" alt="Revenue chart">
<form><label for="email">Email</label><input id="email" type="text"></form>
<p><a href="plan.pdf" aria-label="Download the plan">Download the plan</a></p>
<table><tr><th>plan</th><th>price</th></tr><tr><td>a</td><td>49</td></tr></table>
</section></body></html>`);
  try {
    const result = await convert(src, { out: path.join(dir, 'clean.pdf'), verify: false, auditA11y: true });
    assert.ok(result.a11y, 'the opt-in audit ran and is on the result (not vacuously empty)');
    assert.equal(result.a11y.unlabeledCount, 0, 'every control is named');
    assert.equal(result.a11y.missingAltCount, 0, 'every image carries an alt');
    const report = lintDocument({ input: 'a11y-clean.html', pages: result.pages, audit: result.audit, a11y: result.a11y });
    const a11y = report.findings.filter((f) => f.rule.startsWith('a11y-'));
    assert.deepEqual(a11y, [], `expected no a11y findings, got ${JSON.stringify(report.findings, null, 2)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
