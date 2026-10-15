/**
 * golden.test.mjs — v0.7 `tympan test`: pixel-golden regression.
 *
 * The comparison maths is pure and tested hermetically; the render cycle
 * (record → match → catch a deliberate change → catch a shrunken document)
 * needs Chromium and skips cleanly without it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  compareFingerprints,
  fingerprintSize,
  goldenSlug,
  goldenPageName,
  goldenTest,
  formatGoldenReport,
  DEFAULT_TOLERANCE,
} from '../src/golden.js';
import { findChromium } from '../src/browser.js';

const CLI = fileURLToPath(new URL('../bin/tympan.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-golden-'));
}

const section = (n) =>
  `<section class="page-section" id="s${n}"><h2>Chapter ${n}</h2><p>${('figures and commentary. ').repeat(18)}</p></section>`;

const pageDoc = (style, sections) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>report</title>
<style>body{margin:0;${style}} .page-section{padding:24px;min-height:360px}</style></head><body><main>
${sections}
</main></body></html>`;

const LIGHT = 'background:#ffffff;color:#111111';
const DARK = 'background:#101820;color:#eeeeee';

test('compareFingerprints: identical, rasterizer noise, a real change, a geometry change', () => {
  const base = Array.from({ length: 300 }, () => 200);

  const same = compareFingerprints(base, base.slice());
  assert.equal(same.ok, true);
  assert.equal(same.diffRatio, 0);
  assert.equal(same.reason, null);

  // A uniform 10/255 shift is what a different font rasterizer looks like:
  // under the per-cell threshold, so it must not fail a build.
  const noisy = base.map((v) => v - 10);
  const noise = compareFingerprints(noisy, base);
  assert.equal(noise.ok, true, 'sub-threshold noise is not a regression');
  assert.equal(noise.differing, 0);
  assert.ok(noise.meanDelta > 9 && noise.meanDelta < 11);

  // 8 of 100 cells fully changed is a real change (above the 2% tolerance).
  const changed = base.slice();
  for (let c = 0; c < 8; c++) {
    changed[c * 3] = 0;
    changed[c * 3 + 1] = 0;
    changed[c * 3 + 2] = 0;
  }
  const diff = compareFingerprints(changed, base);
  assert.equal(diff.ok, false);
  assert.equal(diff.differing, 8);
  assert.equal(diff.cells, 100);
  assert.ok(diff.diffRatio > DEFAULT_TOLERANCE);
  assert.equal(diff.maxDelta, 200);

  // A different grid is a geometry signal, not a numeric comparison.
  const resized = compareFingerprints(base, base.slice(0, 30));
  assert.equal(resized.ok, false);
  assert.equal(resized.reason, 'size mismatch');
  assert.equal(compareFingerprints(null, base).reason, 'missing fingerprint');
  assert.equal(compareFingerprints(null, null).reason, 'no fingerprint at all');
  assert.equal(compareFingerprints([1, 2], []).reason, 'size mismatch');
});

test('fingerprintSize keeps the page aspect', () => {
  assert.deepEqual(fingerprintSize(595, 842), { w: 96, h: 136 });
  assert.deepEqual(fingerprintSize(842, 595), { w: 96, h: 68 });
});

test('goldenSlug is stable and unique per input path', () => {
  const a = goldenSlug('/tmp/deck.html');
  assert.equal(a, goldenSlug('/tmp/deck.html'));
  assert.notEqual(a, goldenSlug('/tmp/other/deck.html'));
  assert.match(a, /^deck-[0-9a-f]{8}$/);
  assert.equal(goldenPageName(7), 'p007.png');
});

test('goldenTest: record, match, catch a deliberate change, catch a shrunk document', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  const goldenDir = path.join(dir, 'golden');
  const src = path.join(dir, 'report.html');
  const write = (body) => fs.writeFileSync(src, body);
  const run = (options = {}) => goldenTest([src], { goldenDir, ...options });
  try {
    // 1. Record two pages.
    write(pageDoc(LIGHT, section(1) + section(2)));
    const recorded = await run({ update: true });
    assert.equal(recorded.ok, true, JSON.stringify(recorded.entries[0]));
    assert.deepEqual(
      recorded.entries[0].pages.map((p) => p.status),
      ['created', 'created']
    );
    const baseline = path.join(goldenDir, goldenSlug(src), goldenPageName(1));
    assert.ok(fs.existsSync(baseline), `baseline recorded at ${baseline}`);
    assert.equal(fs.readFileSync(baseline).subarray(1, 4).toString(), 'PNG', 'baseline is a viewable PNG');

    // 2. Re-running an unchanged document matches: the fingerprint is stable
    //    across conversions (deterministic PDF → deterministic pixels).
    const matched = await run();
    assert.equal(matched.ok, true, JSON.stringify(matched.entries[0].pages));
    assert.deepEqual(
      matched.entries[0].pages.map((p) => p.status),
      ['match', 'match']
    );
    assert.equal(matched.entries[0].pages[0].differing, 0, 'byte-identical input renders identically');

    // 3. A restyled document is caught, and the report says where.
    write(pageDoc(DARK, section(1) + section(2)));
    const changed = await run();
    assert.equal(changed.ok, false);
    assert.deepEqual(
      changed.entries[0].pages.map((p) => p.status),
      ['diff', 'diff']
    );
    assert.ok(changed.entries[0].pages[0].diffRatio > DEFAULT_TOLERANCE);
    const text = formatGoldenReport(changed);
    assert.match(text, /DIFFERS/);
    assert.match(text, /baseline/);

    // 4. A document that lost a page fails too — a missing page must not pass
    //    by simply never being compared.
    write(pageDoc(LIGHT, section(1)));
    const shrunk = await run();
    assert.equal(shrunk.ok, false);
    assert.deepEqual(shrunk.entries[0].stale, [goldenPageName(2)]);
    assert.deepEqual(shrunk.entries[0].pages.map((p) => p.status), ['match']);
    assert.match(formatGoldenReport(shrunk), /stale baseline/);

    // 5. A first run without --update explains itself instead of writing files.
    const fresh = path.join(dir, 'fresh');
    const unrecorded = await goldenTest([src], { goldenDir: fresh });
    assert.equal(unrecorded.ok, false);
    assert.equal(unrecorded.entries[0].pages[0].status, 'missing');
    assert.match(formatGoldenReport(unrecorded), /--update/);
    assert.ok(!fs.existsSync(path.join(fresh, goldenSlug(src))), 'a compare run never writes baselines');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: tympan test --update records, then a change fails the run', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  try {
    fs.writeFileSync(path.join(dir, 'deck.html'), pageDoc(LIGHT, section(1)));
    const record = spawnSync(process.execPath, [CLI, 'test', 'deck.html', '--update'], { cwd: dir, encoding: 'utf8' });
    assert.equal(record.status, 0, record.stderr);
    assert.match(record.stderr, /baselines recorded/);

    const pass = spawnSync(process.execPath, [CLI, 'test', 'deck.html', '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(pass.status, 0, pass.stderr);
    const report = JSON.parse(pass.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.entries[0].pages[0].status, 'match');
    assert.equal(report.entries[0].input, path.join(dir, 'deck.html'));

    fs.writeFileSync(path.join(dir, 'deck.html'), pageDoc(DARK, section(1)));
    const broke = spawnSync(process.execPath, [CLI, 'test', 'deck.html'], { cwd: dir, encoding: 'utf8' });
    assert.equal(broke.status, 1, broke.stdout);
    assert.match(broke.stderr, /DIFFERS/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
