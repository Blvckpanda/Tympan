/**
 * strategies.test.mjs — every detection rung of detect.js exercised end-to-end
 * through convert(): asserted strategy, section count, pages === sections.
 * Needs Chromium; skips cleanly when it is unavailable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/index.js';
import { findChromium } from '../src/browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', name);
const out = (name) => path.join(here, 'out', name);
const skip = findChromium() ? false : 'Chromium not available';

async function convertAndClean(fixtureName, outName, options = {}) {
  const result = await convert(fixture(fixtureName), { out: out(outName), ...options });
  for (const f of [result.master, result.email].filter(Boolean)) {
    await fs.promises.rm(f, { force: true });
  }
  return result;
}

function assertOnePagePerSection(result) {
  assert.ok(result.verification, 'verification ran');
  assert.equal(result.verification.sectionCount, result.detection.sections.length);
  for (const o of result.verification.outputs) {
    assert.equal(o.pages, result.detection.sections.length, `${o.file}: pages === sections`);
  }
}

test('data-page rung: 3 sections, one page each', { skip }, async () => {
  const r = await convertAndClean('ai-deck-datapage.html', 'datapage.pdf');
  assert.equal(r.detection.strategy, 'data-attribute');
  assert.equal(r.detection.sections.length, 3);
  assertOnePagePerSection(r);
});

test('data-slide rung: 2 sections, one page each', { skip }, async () => {
  const r = await convertAndClean('ai-deck-dataslide.html', 'dataslide.pdf');
  assert.equal(r.detection.strategy, 'data-attribute');
  assert.equal(r.detection.sections.length, 2);
  assertOnePagePerSection(r);
});

test('semantic-children rung: 3 plain sections, one page each', { skip }, async () => {
  const r = await convertAndClean('ai-deck-semantic.html', 'semantic.pdf');
  assert.equal(r.detection.strategy, 'semantic-children');
  assert.equal(r.detection.sections.length, 3);
  assertOnePagePerSection(r);
});

test('whole-document fallback: unstructured page becomes 1 page', { skip }, async () => {
  const r = await convertAndClean('ai-deck-plain.html', 'plain.pdf');
  assert.equal(r.detection.strategy, 'whole-document');
  assert.equal(r.detection.sections.length, 1);
  assertOnePagePerSection(r);
});

test('precedence: page-section-class beats data-page on the same document', { skip }, async () => {
  const r = await convertAndClean('ai-deck-precedence.html', 'precedence.pdf');
  assert.equal(r.detection.strategy, 'page-section-class');
  assert.equal(r.detection.sections.length, 2);
  assertOnePagePerSection(r);
});

test('explicit selector beats every rung', { skip }, async () => {
  const r = await convertAndClean('ai-deck-precedence.html', 'selector.pdf', {
    selector: 'section[data-page]',
  });
  assert.equal(r.detection.strategy, 'selector');
  assert.equal(r.detection.sections.length, 1);
  assertOnePagePerSection(r);
});
