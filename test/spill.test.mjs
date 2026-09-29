/**
 * spill.test.mjs — regression tests for the shrink-to-fit spill fix (v0.3.3).
 *
 * The bug this pins: printSection used to measure the section once (open
 * loop) and print at the boundary scale. A webfont injected by the page
 * AFTER document.fonts.ready — Google Fonts loaded from a runtime script —
 * swapped in after the measurement, making the real print layout taller
 * than measured; Chromium's print rounding spilled sub-pixel remainders
 * onto a sliver second page. Six of seven sections of a real document
 * spilled before the closed loop (print -> count pages -> shrink until one)
 * replaced the open-loop estimate.
 *
 * These tests reproduce that exact race — a font injected from a
 * fonts.ready.then() callback, i.e. after both readiness signals and the
 * height measurement, but before page.pdf() — and assert the invariant:
 * a tall section with a late webfont still prints to EXACTLY ONE page.
 *
 * The webfont cases need network access to fonts.googleapis.com and skip
 * cleanly without it. The boundary case is fully hermetic.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { printSection, resolveGeometry } from '../src/pipeline.js';
import { chromium } from 'playwright';
import { findChromium, launchOptions } from '../src/browser.js';

const GEO = resolveGeometry({});
// Landscape A4: 8.27in tall, 0.4in margins top+bottom -> 7.47in usable = 717.12 CSS px.
const USABLE_PX = (GEO.H_IN - GEO.margins.top - GEO.margins.bottom) * 96;

/** A minimal clean-document template, as the pipeline would build it. */
const TEMPLATE =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
  'html,body{margin:0;padding:0;background:#fff}' +
  "main{margin:0 auto;max-width:870px;font-family:system-ui,sans-serif}" +
  '</style></head><body><main></main></body></html>';

/**
 * A section of ~`lines` text lines. Line-height 40px makes the height
 * deterministic within a pixel or two at width 870.
 */
function tallSection(lines) {
  const ps = Array.from({ length: lines }, (_, i) => `<p>Line ${i + 1} — the quick brown fox jumps over the lazy dog</p>`)
    .join('\n');
  return `<section id="tall"><h1>Tall section</h1>${ps}</section>`;
}

const CSS =
  'section{padding:0}p{font-size:24px;line-height:40px;margin:0}h1{font-size:40px;line-height:48px;margin:0 0 8px}';

/**
 * Script string injected into the section: swaps in Bungee (a webfont with
 * much larger glyphs than the fallback stack) from inside fonts.ready —
 * the exact timing that defeated open-loop measurement. Resolves the
 * font load so the test can await certainty that the swap happened.
 */
const LATE_FONT_SCRIPT =
  '<script>window.__fontLoaded=false;' +
  'document.fonts.ready.then(function(){' +
  'var l=document.createElement("link");l.rel="stylesheet";' +
  'l.href="https://fonts.googleapis.com/css2?family=Bungee&display=block";' +
  'document.head.appendChild(l);' +
  'var st=document.createElement("style");' +
  'st.textContent="p{font-family:Bungee,system-ui,sans-serif}";' +
  'document.head.appendChild(st);' +
  'fetch("https://fonts.googleapis.com/css2?family=Bungee&display=block")' +
  '.then(function(){return document.fonts.load("40px Bungee");})' +
  '.then(function(){window.__fontLoaded=true;})' +
  '.catch(function(){window.__fontLoaded=true;});' +
  '});</script>';

async function pageCount(file) {
  return (await PDFDocument.load(fs.readFileSync(file))).getPageCount();
}

/** Fetch latency probe: can we reach Google Fonts at all? */
async function googleFontsReachable(timeoutMs = 2000) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    await fetch('https://fonts.googleapis.com/css2?family=Bungee&display=swap', { signal: ac.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

test('boundary-height section prints to exactly one page (hermetic)', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const browser = await chromium.launch(launchOptions());
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-spill-')), 'boundary.pdf');
  try {
    // 17 text lines + heading ≈ 748px ≈ 104% of usable height: just over the
    // boundary, so the shrink loop must actually engage (not a trivial no-op).
    await printSection(browser, TEMPLATE + `<style>${CSS}</style>`, tallSection(17), out, GEO);
    assert.equal(await pageCount(out), 1, 'boundary section spilled: shrink loop failed to hold one page');
  } finally {
    await browser.close();
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test('late-applying webfont still yields exactly one page per section', async (t) => {
  if (!(await googleFontsReachable())) return t.skip('fonts.googleapis.com unreachable');
  if (!findChromium()) return t.skip('Chromium not available');
  const browser = await chromium.launch(launchOptions());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-spill-'));
  try {
    // Boundary height (~104% of usable) AND ~160% of usable, both with the
    // late font swap. Regardless of which layout wins the race, the closed
    // loop must land the section on exactly one page.
    for (const [name, lines] of [['boundary.pdf', 17], ['taller.pdf', 25]]) {
      const html = tallSection(lines) + LATE_FONT_SCRIPT;
      const out = path.join(dir, name);
      await printSection(browser, TEMPLATE + `<style>${CSS}</style>`, html, out, GEO);
      assert.equal(await pageCount(out), 1, `${name}: late webfont spilled the section`);
    }
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('end-to-end: tall multi-section document converts one page per section', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const { convert } = await import('../src/index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-spill-'));
  const src = path.join(dir, 'tall-doc.html');
  // Three sections in the 100–170% height band — tall enough that every
  // section must shrink, none so extreme that readability is the question.
  const section = (id, lines) =>
    `<section class="page-section" id="${id}"><h1>Section ${id}</h1>${tallSection(lines).replace(/^<section[^>]*>|<\/section>$/g, '')}</section>`;
  fs.writeFileSync(
    src,
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>tall doc</title><style>' +
      CSS +
      '</style></head><body><main>' +
      section('one', 17) +
      section('two', 22) +
      section('three', 26) +
      '</main></body></html>'
  );
  try {
    const result = await convert(src, { out: path.join(dir, 'tall-doc.pdf'), probe: 'Section three' });
    assert.equal(result.detection.sections.length, 3);
    assert.equal(result.verification.ok, true, JSON.stringify(result.verification));
    assert.equal(result.verification.sectionCount, 3);
    for (const o of result.verification.outputs) {
      assert.equal(o.pages, 3, `${o.file}: expected exactly one page per section`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
