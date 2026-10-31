/**
 * auto.test.mjs — the `--layout auto` chooser.
 *
 * The chooser is pure arithmetic over measurements, so the rule table is
 * tested directly; one browser-backed conversion proves the pipeline
 * measures, picks, and reports.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseLayout, greedyFlowPages } from '../src/auto.js';
import { convert } from '../src/pipeline.js';
import { findChromium } from '../src/browser.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-auto-'));

// One A4 portrait sheet of usable text area, per resolveGeometry defaults.
const USABLE = Math.round((11.69 - 0.4 - 0.4) * 96); // 1045 px

test('greedyFlowPages: blocks pack, oversized blocks split, total is >= sum/usable', () => {
  assert.equal(greedyFlowPages([], USABLE), 1);
  assert.equal(greedyFlowPages([300, 400, 300], USABLE), 1);
  assert.equal(greedyFlowPages([800, 800], USABLE), 2);
  assert.equal(greedyFlowPages([800, 500], USABLE), 2);
  // 2500px of content can never fit on two 1045px shelves
  assert.equal(greedyFlowPages([1300, 1200], USABLE), 3);
  // guaranteed lower bound
  const heights = [100, 200, 300, 400, 500];
  assert.ok(greedyFlowPages(heights, USABLE) >= Math.ceil(heights.reduce((a, b) => a + b) / USABLE));
});

test('chooseLayout: sparse prose picks flow and says why in numbers', () => {
  const r = chooseLayout({
    sections: [400, 350, 500, 300].map((heightPx) => ({ heightPx, scaleUsed: 1 })),
    usablePx: USABLE,
  });
  assert.equal(r.picked, 'flow');
  assert.ok(r.deckFill < 0.5);
  assert.ok(r.flowFill > r.deckFill, 'flowing the same blocks carries more');
  assert.ok(/fill only/.test(r.reason) && /\d+%/.test(r.reason));
  assert.equal(r.deckPages, 4);
  assert.equal(r.flowPages, 2);
});

test('chooseLayout: a full sheet that fits at full width stays deck', () => {
  // one section ~98% of the sheet, scale 1: nothing wasted, nothing shrunk
  const r = chooseLayout({
    sections: [{ heightPx: Math.round(USABLE * 0.98), scaleUsed: 1 }],
    usablePx: USABLE,
  });
  assert.equal(r.picked, 'deck');
  assert.equal(r.deckFill, 0.98);
  assert.ok(/already fill/.test(r.reason));
});

test('chooseLayout: a section that must shrink below the floor picks flow even at 97% fill', () => {
  // deck fill would be fine, but the width bound forces a 0.9 scale
  const h = Math.round(USABLE * 1.05); // taller than the sheet
  const r = chooseLayout({
    sections: [{ heightPx: h, scaleUsed: 0.9 }],
    usablePx: USABLE,
  });
  assert.equal(r.picked, 'flow');
  assert.ok(/scale 1|shrink/.test(r.reason));
});

test('chooseLayout: sparse sections whose flowing would move content back to deck', () => {
  // many tiny sections: deck fill low, but the greedy flow estimate is no
  // better because each block must start its own shelf
  const r = chooseLayout({
    sections: Array.from({ length: 6 }, () => ({ heightPx: 700, scaleUsed: 1 })),
    usablePx: 1045,
    targetFill: 0.7,
  });
  // 700+345 does NOT fit (700+700>1045), so flow packs 1 per page too:
  // flowFill == deckFill, deck wins the tie
  assert.equal(r.picked, 'deck');
  assert.equal(r.deckFill, r.flowFill);
});

test('pipeline: --layout auto on a prose fixture picks flow and carries the numbers', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const out = path.join(OUT, 'auto-prose.pdf');
  const r = await convert(`${FIXTURES}flow-prose.html`, { out, layout: 'auto' });
  assert.equal(r.layout, 'flow');
  assert.ok(r.layoutChoice, 'the choice is reported, not implicit');
  assert.equal(r.layoutChoice.picked, 'flow');
  assert.ok(r.layoutChoice.deckFill < 1);
  assert.ok(r.layoutChoice.reason.length > 10);
});

test('pipeline: --layout auto keeps its pick out of default conversions', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  // default run: no chooser, no choice object, layout stays 'section'
  const out = path.join(OUT, 'default.pdf');
  const r = await convert(`${FIXTURES}flow-prose.html`, { out });
  assert.equal(r.layout, 'section');
  assert.equal(r.layoutChoice, null);
});
