/**
 * phase1.test.mjs — v0.6 Phase-1 diagnostics: --wait-for, doctor, --json.
 * Browser tests skip cleanly without Chromium; doctor/report checks are pure.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/index.js';
import { findChromium } from '../src/browser.js';
import { enginePin, doctorChecks, summarizeDoctor } from '../src/doctor.js';
import { buildJsonReport } from '../src/report.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-p1-'));
}

test('doctor checks: required gates and non-required ffmpeg warn', () => {
  const good = doctorChecks({
    nodeVersion: 'v22.11.0',
    engine: { pinned: '1.63.0', installed: '1.63.0', exact: true },
    chromiumPath: 'C:/chrome/chrome.exe',
    ffmpegPath: true,
  });
  assert.equal(good.every((c) => c.ok), true, JSON.stringify(good));
  assert.equal(summarizeDoctor(good).ok, true);

  const bad = doctorChecks({
    nodeVersion: 'v18.0.0',
    engine: { pinned: '^1.60.0', installed: '1.66.0', exact: false },
    chromiumPath: null,
    ffmpegPath: false,
  });
  const byName = Object.fromEntries(bad.map((c) => [c.name, c]));
  assert.equal(byName['node'].ok, false);
  assert.equal(byName['playwright pin'].ok, false, 'caret pin must fail');
  assert.equal(byName['playwright installed'].ok, false, 'installed !== pin must fail');
  assert.equal(byName['chromium'].ok, false);
  assert.equal(byName['ffmpeg (demo GIF)'].ok, false);
  assert.equal(byName['ffmpeg (demo GIF)'].required, false, 'ffmpeg is a warning, not a failure');
  const s = summarizeDoctor(bad);
  assert.equal(s.ok, false);
  assert.equal(s.failed, 4, 'node + pin + installed + chromium fail; ffmpeg must not count (warn only)');
});

test('enginePin reads the checkout pin as exact', () => {
  const e = enginePin();
  assert.equal(e.pinned, '1.63.0');
  assert.equal(e.exact, true);
  assert.equal(e.installed, '1.63.0');
});

test('buildJsonReport: stable machine-readable shape', () => {
  const report = buildJsonReport({
    master: '/tmp/out.pdf',
    email: null,
    detection: { strategy: 'semantic-children', confidence: 0.6, sections: [{ id: 'a' }, { id: 'b' }, { id: 'prelude', prelude: true }] },
    background: '#070b10',
    contentMaxWidth: 1000,
    blockedRequests: 2,
    verification: { ok: true, outputs: [{ file: '/tmp/out.pdf', pages: 3, expected: 3, pagesOk: true, probeOk: true, sizeBytes: 123 }] },
  }, { input: '/tmp/in.html', totalMs: 4321 });
  assert.equal(report.ok, true);
  assert.equal(report.master, '/tmp/out.pdf');
  assert.equal(report.detection.sections, 3);
  assert.equal(report.detection.prelude, true);
  assert.equal(report.blockedRequests, 2);
  assert.equal(report.totalMs, 4321);
  assert.deepEqual(report.verification.outputs[0], { file: '/tmp/out.pdf', pages: 3, expected: 3, pagesOk: true, probeOk: true, sizeBytes: 123 });
});

test('wait-for: conversion waits for JS-mounted content before printing', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  const html = `<!DOCTYPE html><html><head><style>.page-section{padding:20px}</style></head><body><main>
    <section class="page-section"><p>static</p><div id="chart"></div></section>
  </main>
  <script>setTimeout(function(){document.getElementById('chart').innerHTML='<p>MOUNTED LATE</p>';},600);</script>
  </body></html>`;
  const src = path.join(dir, 'late.html');
  fs.writeFileSync(src, html);
  try {
    const rWait = await convert(src, { out: path.join(dir, 'wait.pdf'), waitFor: '#chart p' });
    const { extractPages } = await import('../src/verify.js');
    const texts = await extractPages(rWait.master);
    assert.ok(texts.join(' ').includes('MOUNTED LATE'), 'wait-for content must be in the PDF');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wait-for timeout surfaces a clear error', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  const html = `<!DOCTYPE html><html><head><style>.page-section{padding:20px}</style></head><body><main><section class="page-section"><p>x</p></section></main></body></html>`;
  const src = path.join(dir, 'never.html');
  fs.writeFileSync(src, html);
  try {
    await assert.rejects(
      convert(src, { out: path.join(dir, 'x.pdf'), waitFor: '#never', waitTimeout: 300 }),
      /timeout|Timeout/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file:// reads E2E: a converted page can never leak local file content', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  const secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, 'TOPSECRET');
  const fileUrl = 'file:///' + secret.replace(/\\/g, '/');
  const { extractPages } = await import('../src/verify.js');

  // The user-facing guarantee is "no leak", whichever layer enforces it.
  // Chromium pre-blocks page-initiated file:// requests (scheme/mixed-content
  // policy) BEFORE userland route handlers see them, so blockedRequests stays
  // 0 here; the gate's own file:// branch is defense-in-depth, pinned
  // hermetically in unit.test.mjs.
  const attackHtml = (extra) => `<!DOCTYPE html><html><head><style>.page-section{padding:20px}</style></head><body><main>
    <section class="page-section"><p>attacker</p><img src="${fileUrl}">${extra}</section>
  </main></body></html>`;

  // Scenario 1: attacker page served over http (URL input — also covers the
  // v0.6 URL-input path end to end).
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(attackHtml(''));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r = await convert(`http://127.0.0.1:${port}/attack`, {
      out: path.join(dir, 'http.pdf'),
      allowNet: [`127.0.0.1:${port}`],
    });
    assert.equal(r.verification.ok, true, 'http scenario: conversion succeeds');
    assert.equal(r.blockedRequests, 0, 'Chromium pre-blocks before the gate sees it');
    const texts = (await extractPages(r.master)).join(' ');
    assert.ok(!texts.includes('TOPSECRET'), 'http scenario: no local file leak');
  } finally {
    server.close();
  }

  // Scenario 2: attacker page as a local file (tympan's primary input).
  const src = path.join(dir, 'attack.html');
  fs.writeFileSync(src, attackHtml('<img src="http://169.254.169.254/latest/meta-data/">'));
  const r2 = await convert(src, { out: path.join(dir, 'file.pdf') });
  assert.equal(r2.verification.ok, true, 'file scenario: conversion succeeds');
  // Chromium retries aborted image requests, so the count can exceed one;
  // the guarantee is that the gate engaged and nothing leaked.
  assert.ok(r2.blockedRequests >= 1, `the metadata fetch must be gate-blocked, got ${r2.blockedRequests}`);
  const texts2 = (await extractPages(r2.master)).join(' ');
  assert.ok(!texts2.includes('TOPSECRET'), 'file scenario: no local file leak');
});
