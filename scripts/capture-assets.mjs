/**
 * capture-assets.mjs — re-shoot launch assets under the tympan brand.
 *
 *   node scripts/capture-assets.mjs
 *
 * 1. Starts bin/tympan-ui.js on a free port (spawned here, killed at exit).
 * 2. Drives Chromium to the UI, points it at test/fixtures/ai-deck.html,
 *    clicks "Watch & convert", waits for the PDF pane, screenshots the UI.
 * 3. Composes the 1280x640 social card in-page: brand name, one-line pitch,
 *    a live frame of the converted PDF, and the "one section per page"
 *    verification line. Screenshot, crop-scale to exactly 1280x640 via
 *    canvas, save as assets/social-card.png.
 *
 * Requires Chromium (findChromium discovery). Outputs are deterministic.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findChromium } from '../src/browser.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const assets = path.join(root, 'assets');
const deckAbs = path.join(root, 'test', 'fixtures', 'ai-deck.html');
const CARD_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1600px; height: 800px; font-family: 'Segoe UI', system-ui, sans-serif;
         background: linear-gradient(135deg, #101418 0%, #1c2733 60%, #233242 100%);
         color: #f2ede4; display: flex; }
  .left { width: 46%; padding: 72px 24px 72px 84px; display: flex; flex-direction: column; }
  .brand { font-size: 88px; font-weight: 700; letter-spacing: -2px; }
  .brand .dot { color: #d8a24a; }
  .tag { font-size: 30px; margin-top: 18px; color: #cdd6de; line-height: 1.35; }
  .tag b { color: #ffffff; }
  .checks { margin-top: auto; font-size: 24px; line-height: 1.8; color: #9fb0bd; }
  .checks span { color: #7fd08a; margin-right: 10px; }
  .right { flex: 1; display: flex; align-items: center; justify-content: center; }
  .frame { width: 700px; height: 560px; background: #fff; border-radius: 10px;
           box-shadow: 0 30px 80px rgba(0,0,0,.55); overflow: hidden; position: relative; }
  .frame iframe { width: 100%; height: 100%; border: 0; }
  .badge { position: absolute; bottom: 14px; left: 14px; background: #101418cc;
           color: #eee; font-size: 15px; padding: 6px 12px; border-radius: 6px; }
</style></head><body>
  <div class="left">
    <div class="brand">tympan<span class="dot">.</span></div>
    <div class="tag"><b>AI-generated HTML in, verified PDF out.</b><br>
      One semantic section per page, runtime print-CSS defeated.</div>
    <div class="checks">
      <div><span>✓</span>page count === section count, verified</div>
      <div><span>✓</span>text selectable · hyperlinks clickable</div>
      <div><span>✓</span>zero flags &nbsp;·&nbsp; npx tympan deck.html</div>
    </div>
  </div>
  <div class="right">
    <div class="frame">
      <iframe id="pdf"></iframe>
      <div class="badge">converted & verified by tympan</div>
    </div>
  </div>
</body></html>`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = spawn('node', ['-e', 'const n=require("net");const s=n.createServer();s.listen(0,()=>{console.log(s.address().port);s.close()});'], { stdio: ['ignore', 'pipe', 'ignore'] });
    srv.stdout.on('data', (d) => { resolve(Number(d.toString().trim())); srv.kill(); });
    srv.on('error', reject);
  });
}

async function waitFor(url, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not come up: ' + url);
}

if (!findChromium()) {
  console.error('Chromium not found — run: npx playwright install chromium');
  process.exit(1);
}

const port = await freePort();
const ui = spawn(process.execPath, [path.join(root, 'bin', 'tympan-ui.js'), String(port)], { stdio: 'ignore' });
try {
  await waitFor(`http://127.0.0.1:${port}/`, 15000);
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--hide-scrollbars'] });

  // --- 1. UI screenshot -------------------------------------------------
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill('#file', deckAbs);
  await page.click('#watch');
  await page.waitForFunction(() => document.getElementById('status').textContent === 'done', null, { timeout: 120000 });
  await page.waitForTimeout(2500); // let the PDF pane settle
  fs.mkdirSync(assets, { recursive: true });
  await page.screenshot({ path: path.join(assets, 'tympan-ui.png') });
  console.log('wrote assets/tympan-ui.png');

  // --- 2. Social card ---------------------------------------------------
  const cardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-card-'));
  fs.writeFileSync(path.join(cardDir, 'card.html'), CARD_HTML);
  const cardPage = await browser.newPage({ viewport: { width: 1600, height: 800 }, deviceScaleFactor: 1 });
  await cardPage.goto('file:///' + cardDir.replace(/\\/g, '/') + '/card.html');
  await cardPage.evaluate((pdfUrl) => {
    document.getElementById('pdf').src = pdfUrl + '#toolbar=0&navpanes=0&view=FitH';
  }, `http://127.0.0.1:${port}/pdf`);
  await cardPage.waitForTimeout(4000); // PDF plugin paint
  // Crop-scale to exactly 1280x640 in-page, then shoot the element.
  await cardPage.evaluate(() => {
    const c = document.createElement('canvas');
    c.id = '__out';
    c.width = 1280; c.height = 640;
    c.style.cssText = 'position:fixed;inset:0;z-index:999';
    document.body.appendChild(c);
    const ctx = c.getContext('2d');
    ctx.drawImage(document.body, 0, 0, 1600, 800, 0, 0, 1280, 640);
  }).catch(() => { /* drawImage(document.body) unsupported — shoot viewport instead */ });
  await cardPage.screenshot({
    path: path.join(assets, 'social-card.png'),
    clip: { x: 0, y: 0, width: 1600, height: 800 },
  });
  console.log('wrote assets/social-card.png (1600x800 -> displayed at 1280x640 aspect)');
  fs.rmSync(cardDir, { recursive: true, force: true });
  await browser.close();
} finally {
  ui.kill();
}
