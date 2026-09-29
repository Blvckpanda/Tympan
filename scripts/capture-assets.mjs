/**
 * capture-assets.mjs — shoot the launch assets under the tympan brand.
 *
 *   node scripts/capture-assets.mjs
 *
 * 1. Starts bin/tympan-ui.js on a free port (spawned here, killed at exit).
 * 2. UI screenshot: drives Chromium to the UI, converts the DARK PORTRAIT
 *    brief fixture (the v0.5 showcase: hero page, faithful background),
 *    waits for the PDF pane, screenshots at 2x -> assets/tympan-ui.png.
 * 3. Demo GIF: records the same flow as video (a fresh context with
 *    recordVideo), then ffmpeg -> assets/demo.gif (palette-optimized).
 * 4. Social card: 1280x640 "press room" composition — wordmark, specimen
 *    strip (HTML chips fanning into pages), verification checks, and a live
 *    frame of the real converted dark PDF -> assets/social-card.png.
 *
 * Requires Chromium (findChromium discovery) and ffmpeg on PATH for the GIF.
 * Outputs are deterministic.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findChromium } from '../src/browser.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const assets = path.join(root, 'assets');
const deckAbs = path.join(root, 'test', 'fixtures', 'brief-dark.html');

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

/** Drive the UI: point it at the fixture, watch, wait for the PDF pane. */
async function runUiFlow(page) {
  await page.goto('http://127.0.0.1:' + PORT + '/');
  await page.fill('#file', deckAbs);
  await page.click('#watch');
  await page.waitForFunction(() => document.getElementById('status').textContent === 'done', null, { timeout: 180000 });
  await page.waitForTimeout(2500); // PDF pane settle
}

/** The 1280x640 social card. Specimen strip = HTML chips -> printed pages. */
const CARD_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1600px; height: 800px; overflow: hidden;
    font-family: 'Segoe UI', system-ui, sans-serif; color: #f2ede4;
    background:
      radial-gradient(ellipse 70% 90% at 85% 10%, rgba(216,162,74,.10), transparent 60%),
      repeating-linear-gradient(0deg, rgba(255,255,255,.014) 0 1px, transparent 1px 7px),
      linear-gradient(120deg, #0c0f13 0%, #141b24 55%, #1b2836 100%);
    display: flex; }
  /* press roller: the machine that makes the sheets */
  .roller { position: absolute; top: 0; left: 0; right: 0; height: 10px;
    background: linear-gradient(90deg, #d8a24a 0%, #e8c870 30%, #d8a24a 60%, #8a6a34 100%); }
  .left { width: 47%; padding: 66px 20px 56px 80px; display: flex; flex-direction: column; position: relative; }
  .kicker { font-size: 15px; letter-spacing: 6px; text-transform: uppercase; color: #8fa1af; margin-bottom: 14px; }
  .brand { font-size: 96px; font-weight: 700; letter-spacing: -3px; line-height: 1; }
  .brand .dot { color: #d8a24a; }
  .tag { font-size: 27px; margin-top: 20px; color: #cdd6de; line-height: 1.4; }
  .tag b { color: #ffffff; }
  /* specimen strip: sections go in, pages come out */
  .strip { display: flex; align-items: center; gap: 14px; margin-top: 34px; }
  .chip { background: #232f3b; border: 1px solid #3a4a58; border-radius: 6px;
    padding: 8px 12px; font-family: ui-monospace, monospace; font-size: 13px; color: #9fb0bd; }
  .chip b { color: #e8c870; font-weight: 600; }
  .arrow { color: #d8a24a; font-size: 22px; }
  .pages { display: flex; gap: 5px; align-items: flex-end; }
  .page { width: 26px; height: 34px; background: #f4efe6; border-radius: 2px; position: relative; }
  .page::after { content: ''; position: absolute; left: 4px; right: 4px; top: 6px; height: 3px;
    background: #c8b89a; box-shadow: 0 7px 0 #dccfb6, 0 14px 0 #dccfb6; }
  .pages .p2 { height: 40px; } .pages .p3 { height: 46px; background: #101820; }
  .pages .p3::after { background: #31404e; box-shadow: 0 7px 0 #3a4a58, 0 14px 0 #3a4a58; }
  .caption { font-size: 13px; color: #7d8f9c; margin-top: 8px; font-family: ui-monospace, monospace; }
  .checks { margin-top: auto; font-size: 21px; line-height: 1.75; color: #9fb0bd; }
  .checks span { color: #7fd08a; margin-right: 10px; }
  .right { flex: 1; display: flex; align-items: center; justify-content: center; }
  .frame { width: 560px; height: 640px; background: #fff; border-radius: 8px;
    box-shadow: 0 40px 90px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08); overflow: hidden; position: relative; }
  .frame iframe { width: 100%; height: 100%; border: 0; }
  .badge { position: absolute; bottom: 12px; left: 12px; background: #101418cc;
    color: #e8c870; font-size: 14px; padding: 6px 12px; border-radius: 6px;
    font-family: ui-monospace, monospace; }
</style></head><body>
  <div class="roller"></div>
  <div class="left">
    <div class="kicker">html to pdf, verified</div>
    <div class="brand">tympan<span class="dot">.</span></div>
    <div class="tag"><b>AI-generated HTML in, verified PDF out.</b><br>
      One section per page — hero included, backgrounds faithful.</div>
    <div class="strip">
      <div class="chip">&lt;<b>section</b>/&gt;</div><div class="arrow">&#8594;</div>
      <div class="pages"><div class="page"></div><div class="page p2"></div><div class="page p3"></div></div>
      <div class="caption">3 sections = 3 pages, counted, every run</div>
    </div>
    <div class="checks">
      <div><span>&#10003;</span>portrait, page background carried from source</div>
      <div><span>&#10003;</span>byte-identical output for identical input</div>
      <div><span>&#10003;</span>file:// reads &amp; private nets blocked</div>
      <div><span>&#10003;</span>zero flags &nbsp;&middot;&nbsp; npx tympan deck.html</div>
    </div>
  </div>
  <div class="right">
    <div class="frame">
      <iframe id="pdf"></iframe>
      <div class="badge">converted &amp; verified by tympan</div>
    </div>
  </div>
</body></html>`;

if (!findChromium()) {
  console.error('Chromium not found — run: npx playwright install chromium');
  process.exit(1);
}

const PORT = await freePort();
const ui = spawn(process.execPath, [path.join(root, 'bin', 'tympan-ui.js'), String(PORT)], { stdio: 'ignore' });
try {
  await waitFor(`http://127.0.0.1:${PORT}/`, 15000);
  fs.mkdirSync(assets, { recursive: true });

  // --- 1. UI screenshot (2x, portrait dark deck in the pane) -------------
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--hide-scrollbars'] });
  try {
    const shotCtx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
    const shotPage = await shotCtx.newPage();
    await runUiFlow(shotPage);
    await shotPage.screenshot({ path: path.join(assets, 'tympan-ui.png') });
    console.log('wrote assets/tympan-ui.png');
    await shotCtx.close();

    // --- 2. Demo GIF (video of the same flow) ----------------------------
    if (spawnSync('ffmpeg', ['-version']).status !== 0) {
      console.log('ffmpeg not on PATH — skipped assets/demo.gif');
    } else {
      const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-gif-'));
      const gifCtx = await browser.newContext({
        viewport: { width: 1280, height: 860 },
        recordVideo: { dir: videoDir, size: { width: 1280, height: 860 } },
      });
      const gifPage = await gifCtx.newPage();
      await runUiFlow(gifPage);
      const video = gifPage.video();
      await gifCtx.close(); // flushes the video file
      const webm = await video.path();
      const gifPath = path.join(assets, 'demo.gif');
      const ff = spawnSync('ffmpeg', [
        '-y', '-i', webm,
        '-vf', 'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
        '-loop', '0', gifPath,
      ], { stdio: 'ignore' });
      if (ff.status !== 0) {
        console.log('ffmpeg conversion failed — skipped assets/demo.gif');
      } else {
        console.log(`wrote assets/demo.gif (${(fs.statSync(gifPath).size / 1048576).toFixed(1)} MB)`);
      }
      fs.rmSync(videoDir, { recursive: true, force: true });
    }

    // --- 3. Social card (1280x640 with the real converted PDF) -----------
    const cardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-card-'));
    fs.writeFileSync(path.join(cardDir, 'card.html'), CARD_HTML);
    const cardPage = await browser.newPage({ viewport: { width: 1600, height: 800 }, deviceScaleFactor: 1 });
    await cardPage.goto('file:///' + cardDir.replace(/\\/g, '/') + '/card.html');
    await cardPage.evaluate((pdfUrl) => {
      document.getElementById('pdf').src = pdfUrl + '#toolbar=0&navpanes=0&view=FitH';
    }, 'http://127.0.0.1:' + PORT + '/pdf');
    await cardPage.waitForTimeout(4000); // PDF plugin paint
    await cardPage.screenshot({
      path: path.join(assets, 'social-card.png'),
      clip: { x: 0, y: 0, width: 1600, height: 800 },
    });
    console.log('wrote assets/social-card.png (1600x800, 2:1 — GitHub crops to 1280x640)');
    fs.rmSync(cardDir, { recursive: true, force: true });
  } finally {
    await browser.close();
  }
} finally {
  ui.kill();
}
