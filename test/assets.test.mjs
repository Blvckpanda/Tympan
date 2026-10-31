/**
 * assets.test.mjs — local sibling images survive the request gate.
 *
 * Plan v0.8 W1 finding: the gate blocks `file://` reads BY DESIGN, so a
 * sibling `<img>` printed as blank space and lint reported `broken-asset`
 * for a file visibly sitting on disk. The fix inlines the file as a data URI
 * from Node; nothing is unblocked. These tests pin both directions:
 * a real sibling is inlined and painted, a missing one stays broken.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { convert } from '../src/pipeline.js';
import { analyzeFlowPdf } from '../src/flow.js';
import { resolveGeometry } from '../src/pipeline.js';
import { resolveLocalAssets } from '../src/assets.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-assets-'));
const fixture = (name) => path.join(FIXTURES, name);
const out = (name) => path.join(OUT, name);

test('a local sibling image is inlined and really painted into the PDF', async () => {
  const r = await convert(fixture('asset-sibling.html'), { out: out('sibling.pdf'), flow: true });
  // gate blocked it during load, then Node inlined it before detection ran
  assert.ok(r.assetInlining.inlined === 1, `expected 1 inlined asset, got ${r.assetInlining.inlined}`);
  assert.equal(r.assetInlining.urls.length, 1);
  assert.ok(/file:/.test(r.assetInlining.urls[0]), 'the inlined URL is the page-local file URL');
  assert.ok(r.assetInlining.bytes > 0);
  // the audit is honest after the fix: nothing failed in the printed layout
  assert.deepEqual(r.audit.brokenImages, []);
  const deep = r.audit.brokenImages.filter((b) => (b.src || '').includes('asset-logo.png'));
  assert.equal(deep.length, 0, 'asset-logo.png is no longer reported broken');
  // the pixels are in the file: flow mode measures image paint ops from the PDF
  const analysis = await analyzeFlowPdf(r.master, resolveGeometry());
  const withImages = analysis.pages.filter((p) => p.imageOps > 0);
  assert.ok(withImages.length > 0, 'the data URI image made it into the printed bytes');
});

test('section mode gets the same fix (data URI carries through the section HTML)', async () => {
  const r = await convert(fixture('asset-sibling.html'), { out: out('sibling-section.pdf') });
  assert.equal(r.layout, 'section');
  assert.equal(r.assetInlining.inlined, 1);
  assert.deepEqual(r.audit.brokenImages, []);
});

test('a missing sibling stays broken and is reported, not silently absorbed', () => {
  const { map, inlined, skipped } = resolveLocalAssets([
    pathToFileURL(fixture('nope.png')).href,
  ]);
  assert.deepEqual(map, {});
  assert.equal(inlined.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'file does not exist');
});

test('resolveLocalAssets bounds: unknown extension, oversized, directory', () => {
  const htmlUrl = pathToFileURL(fixture('asset-sibling.html')).href;
  const logoUrl = pathToFileURL(fixture('asset-logo.png')).href;
  // the HTML file itself: real, readable, but not an image
  const a = resolveLocalAssets([htmlUrl, logoUrl]);
  assert.equal(a.inlined.length, 1, 'only the image is inlined');
  const s = a.skipped.find((x) => x.url === htmlUrl);
  assert.equal(s.reason, '.html is not a known image type');
  // oversized: the cap is injectable
  const c = resolveLocalAssets([logoUrl], { maxBytes: 0, stat: () => ({ isFile: () => true, size: 1 }) });
  assert.equal(c.inlined.length, 0);
  assert.equal(c.skipped[0].reason.includes('larger than'), true);
  // a directory is not an asset
  const d = resolveLocalAssets([pathToFileURL(FIXTURES).href + '/'], { stat: () => ({ isFile: () => false, size: 8 }) });
  assert.equal(d.inlined.length, 0);
  assert.equal(d.skipped[0].reason, 'not a regular file');
});
