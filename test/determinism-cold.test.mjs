/**
 * determinism-cold.test.mjs — cross-process determinism on the FIRST run.
 *
 * The headline "same input, same bytes" must hold the way a CI job or a
 * first-run user experiences it: two conversions in two separate node
 * processes, each launching its own Chromium profile, with no warm-up
 * conversion in between and no shared state. fidelity.test.mjs's determinism
 * case runs both conversions in ONE process, which is exactly what the suite
 * otherwise never covers.
 *
 * RESOLVED BISECT (2026-10-22). The post-restart suite run's cold pair once
 * produced two different hashes. Cold reproduction attempts put the rate at
 * roughly 3 divergent rounds out of 10 for this network-font fixture, and the
 * divergent pair settled the mechanism at the glyph level:
 *
 *   - Layout, extracted text and rendered pixels were IDENTICAL: the
 *     96x?-cell golden fingerprints differed in 0 cells on every page and
 *     pdf-text extraction agreed on all four pages.
 *   - The only byte difference was inside the embedded font subsets: one
 *     subset's glyph keys were renumbered by exactly -1 across the board
 *     (a: g0,g1,g6,gA,gD,...,g2E,g30 vs b: g0,g1,g5,g9,gC,...,g2D,g2F), one
 *     width entry shifting with them — the signature of ONE GLYPH being
 *     absent from the other run's font binary.
 *   - 15 of 16 CharProc outlines were byte-identical under that removal map
 *     (the 16th differs sub-pixel-precisely, invisible at fingerprint scale),
 *     confirming the two runs loaded two DIFFERENT woff2 binaries of the
 *     same fonts.gstatic.com URL.
 *
 * So the flake is IBM Plex Sans on Google's CDN rotating its woff2 bytes
 * between two independent cold fetches, not pipeline nondeterminism.
 * fixtures/brief-dark.html fetches that font over the network, so its pair
 * can never be a byte-determinism witness on its own: this file therefore
 * pins three tiers.
 *
 *   1. coldfont.html   (system fallback, no webfont): strict byte equality.
 *   2. coldfont-web    (the committed latin VF woff2 loaded via local
 *      @font-face — generated at test time with absolute file:// srcs so the
 *      print pages resolve them): strict byte equality. This exercises the
 *      complete webfont path (face load, subset, glyph-key embedding) with
 *      bytes the test owns.
 *   3. brief-dark.html (live css2/gstatic fetch): render-level equality only.
 *      A Google rotation that preserves outlines changes glyph KEYS, hence
 *      the output bytes, but not the document; the pipeline's own guarantee
 *      for it is page count, per-page fill and identical fingerprints.
 *      Hash equality is asserted when both runs fetched the same binary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findChromium } from '../src/browser.js';
import { measureFills } from '../src/golden.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const briefDark = path.join(here, 'fixtures', 'brief-dark.html');
const coldFallback = path.join(here, 'fixtures', 'coldfont.html');

/** Convert once in a fresh process; returns the PDF bytes on success. */
function coldConvert(fixturePath, outPath) {
  const out = path.join(outPath);
  const res = spawnSync(
    process.execPath,
    [path.join(root, 'bin', 'tympan.js'), fixturePath, '--format', 'a4',
     '--title', 'cold determinism', '--json', '-o', out],
    { encoding: 'utf8', timeout: 240000 }
  );
  if (res.status !== 0) {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
    throw new Error('cold conversion failed (exit ' + res.status + '): '
      + (res.stderr || res.stdout || '').slice(-400));
  }
  return fs.readFileSync(out);
}

/** One cold pair, hashed. Returns { hashA, hashB, bufA, bufB }. */
function coldPair(fixturePath, dir, name) {
  const bufA = coldConvert(fixturePath, path.join(dir, name + '-a.pdf'));
  const bufB = coldConvert(fixturePath, path.join(dir, name + '-b.pdf'));
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  return { bufA, bufB, hashA: sha(bufA), hashB: sha(bufB) };
}

/**
 * Render both PDFs to golden.js's 96-cell fingerprint grid (pdfjs in a page,
 * same raster path goldenTest uses) and compare page for page.
 */
async function fingerprintPair(bufA, bufB) {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('../src/browser.js');
  const { compareFingerprints, FINGERPRINT_WIDTH, SUPERSAMPLE } = await import('../src/golden.js');
  const W = FINGERPRINT_WIDTH, SS = SUPERSAMPLE;
  const browser = await chromium.launch(launchOptions({}));
  const fingerprints = async (buf) => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1600 } });
    try {
      await page.setContent('<!doctype html><meta charset="utf-8"><body>raster harness</body>');
      await page.addScriptTag({ content: fs.readFileSync(path.join(root,
        'node_modules', 'pdfjs-dist', 'build', 'pdf.min.js'), 'utf8') });
      await page.addScriptTag({ content: fs.readFileSync(path.join(root,
        'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.js'), 'utf8') });
      return await page.evaluate(async ({ b64, W, SS }) => {
        const raw = atob(b64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
        const out = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const pg = await doc.getPage(n);
          const nat = pg.getViewport({ scale: 1 });
          const vp = pg.getViewport({ scale: (W * SS) / nat.width });
          const big = document.createElement('canvas');
          big.width = Math.max(1, Math.round(vp.width));
          big.height = Math.max(1, Math.round(vp.height));
          const bctx = big.getContext('2d', { willReadFrequently: true });
          bctx.fillStyle = '#ffffff';
          bctx.fillRect(0, 0, big.width, big.height);
          await pg.render({ canvasContext: bctx, viewport: vp }).promise;
          const w = W, h = Math.max(1, Math.round((W * big.height) / big.width));
          const small = document.createElement('canvas');
          small.width = w; small.height = h;
          const ctx = small.getContext('2d', { willReadFrequently: true });
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(big, 0, 0, w, h);
          const data = ctx.getImageData(0, 0, w, h).data;
          const rgb = new Array(w * h * 3);
          for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
            rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2];
          }
          out.push({ n, w, h, rgb });
        }
        return out;
      }, { b64: buf.toString('base64'), W, SS });
    } finally { await page.close(); }
  };
  try {
    const [fa, fb] = [await fingerprints(bufA), await fingerprints(bufB)];
    const byPage = (list) => new Map(list.map((p) => [p.n, p]));
    const pa = byPage(fa), pb = byPage(fb);
    const pagesA = fa.map((p) => p.n).sort((a, b) => a - b);
    const pagesB = fb.map((p) => p.n).sort((a, b) => a - b);
    const samePagination = pagesA.length === pagesB.length
      && pagesA.every((n) => pagesB.includes(n));
    const perPage = pagesA.map((n) => {
      const a = pa.get(n), b = pb.get(n);
      if (!a || !b) return { n, ok: false, reason: 'missing page' };
      if (a.rgb !== null && b.rgb !== null
        && (a.w !== b.w || a.h !== b.h)) return { n, ok: false, reason: 'page size changed' };
      if (a.rgb === null || b.rgb === null) return { n, ok: false, reason: 'unreadable page' };
      const c = compareFingerprints(a.rgb, b.rgb, { tolerance: 0.02 });
      return { n, ok: c.differing === 0, reason: c.differing
        ? `${c.differing}/${c.cells} cells differ (maxDelta ${c.maxDelta})` : null };
    });
    return { samePagination, perPage, allPixelEqual: samePagination && perPage.every((p) => p.ok) };
  } finally { await browser.close(); }
}

function assertStrictPair(pair, label) {
  if (pair.hashA !== pair.hashB) {
    throw new Error(
      label + ': same input must give byte-identical PDFs across separate cold'
      + ' processes — hashes ' + pair.hashA.slice(0, 16) + ' vs ' + pair.hashB.slice(0, 16)
      + '. With a fixture whose fonts come from disk this is a pipeline fault;'
      + ' the cause is inside whatever loaded or encoded differently between'
      + ' the two runs.'
    );
  }
}

test('cold-start determinism, system fonts only: byte-identical across first-run processes', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-cold-'));
  try {
    const pair = coldPair(coldFallback, dir, 'system');
    assertStrictPair(pair, 'coldfont.html (system fallback)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cold-start determinism, webfont from disk: byte-identical across first-run processes', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  if (!fs.existsSync(path.join(here, 'fixtures', 'fonts', 'plex-400-latin.woff2'))) {
    return t.skip('committed latin woff2 fixtures are missing');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-cold-'));
  try {
    // Same DOM as brief-dark, but the webfont faces come from the committed
    // files via absolute file:// URLs: the SOURCE page loads them directly
    // and the print pages (which re-declare the stylesheet through the
    // template) can still resolve them, unlike a sibling-relative src.
    const fontA = pathToFileURL(path.join(here, 'fixtures', 'fonts', 'plex-300-latin.woff2')).href;
    const fontB = pathToFileURL(path.join(here, 'fixtures', 'fonts', 'plex-400-latin.woff2')).href;
    const faces = [
      "@font-face { font-family: 'IBM Plex Sans'; font-style: normal; font-weight: 300;"
      + ` font-stretch: 100%; font-display: swap; src: url('${fontA}') format('woff2'); }`,
      "@font-face { font-family: 'IBM Plex Sans'; font-style: normal; font-weight: 400;"
      + ` font-stretch: 100%; font-display: swap; src: url('${fontB}') format('woff2'); }`,
    ].join('\n  ');
    const html = fs.readFileSync(briefDark, 'utf8').replace(/^\s*@import[^\n]*\n/m, '  ' + faces + '\n');
    if (html === fs.readFileSync(briefDark, 'utf8')) throw new Error('fixture rewrite failed');
    const fixturePath = path.join(dir, 'coldfont-web.html');
    fs.writeFileSync(fixturePath, html);
    const pair = coldPair(fixturePath, dir, 'webfont');
    assertStrictPair(pair, 'coldfont-web.html (local IBM Plex vF woff2)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cold-start determinism, live network webfont: render-stable under upstream font rotation', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-cold-'));
  try {
    const pair = coldPair(briefDark, dir, 'network');
    if (pair.hashA === pair.hashB) {
      t.diagnostic('network cold pair: byte-identical (same upstream binary both runs)');
      return;
    }
    // Different bytes is EXPECTED whenever Google hands the two runs two
    // different woff2 binaries (recorded 2026-10-22; the rotated binary had
    // one fewer glyph, renumbering every glyph key). The pipeline's own
    // guarantee for a drifted upstream face is rendered equality, not byte
    // equality of a file the tool does not control.
    const raster = await fingerprintPair(pair.bufA, pair.bufB);
    const fillsA = await measureFills(path.join(dir, 'network-a.pdf'), null).catch(() => null);
    const fillsB = await measureFills(path.join(dir, 'network-b.pdf'), null).catch(() => null);
    const fillsEqual = !!fillsA && !!fillsB
      && fillsA.length === fillsB.length
      && fillsA.every((f, i) => Math.abs(f - fillsB[i]) <= 0.01);
    assert.ok(raster.allPixelEqual,
      'renders must agree even when the upstream font bytes rotate — '
      + JSON.stringify(raster.perPage));
    assert.equal(raster.samePagination, true, 'page count must agree');
    assert.ok(fillsEqual,
      'per-page fill must agree even when the upstream font bytes rotate — '
      + JSON.stringify({ fillsA, fillsB }));
    t.diagnostic(
      'network cold pair: byte hashes DIFFER (upstream webfont rotation: '
      + pair.hashA.slice(0, 12) + ' vs ' + pair.hashB.slice(0, 12)
      + '), fingerprints identical on all pages and fills agree — recorded as'
      + ' the Google-Fonts byte-rotation mechanism, not pipeline nondeterminism'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

