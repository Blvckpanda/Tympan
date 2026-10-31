/**
 * preview.js — `tympan preview`: see where the cut will fall, before converting.
 *
 * Printing is the only way to be CERTAIN about a page break (the printer closes
 * its loop by counting the pages Chromium actually produced). Everything else
 * about a sheet is known earlier, from the DOM — and that is what this shows:
 * one paper-sized sheet per detected section, carrying the section's own
 * rendering, the text area drawn to scale, the shrink factor, and how much of
 * the sheet the content will occupy.
 *
 * The measurement is not a second implementation: it runs the printer's own
 * template, its own waits and its own `measureBlockInPage`, then judges the
 * numbers with `metrics.js` and rules over them with `lint.js`. A preview that
 * measured differently from the converter would be a preview that lies.
 *
 * Zero dependencies: a local HTTP server from `node:http`, one page of vanilla
 * JS, and Server-Sent Events for live reload. It binds to 127.0.0.1 only.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { launchOptions } from './browser.js';
import { loadAndExtract, measureSections, resolveGeometry } from './pipeline.js';
import { withPrelude } from './detect.js';
import { mergeFooter } from './email.js';
import { judgePage, summarizeQuality, formatQualityLine } from './metrics.js';
import { lintDocument, summarizeLint } from './lint.js';

/** Default preview port (overridable with --port; 0 picks a free one). */
export const PREVIEW_DEFAULT_PORT = 4319;

/** A4 at 96dpi — the sheet the overlay is drawn on, in CSS pixels. */
export function sheetSizePx(geo) {
  return { w: Math.round(geo.W_IN * 96), h: Math.round(geo.H_IN * 96) };
}

/**
 * Build the preview report for one document.
 *
 * Shares the conversion path up to (but not including) printing, so what it
 * reports is what the converter will do: same template, same sections, same
 * prelude/footer merge, same measurements.
 *
 * @param {object} options { input, browser, shotDir, ...convert options }
 * @returns {Promise<object>} JSON-serializable report for the preview page
 */
export async function buildPreviewReport(options) {
  const { input, browser: given, shotDir, ...rest } = options;
  const geo = resolveGeometry(rest);
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`);
  const owned = given ? null : await chromium.launch(launchOptions(rest));
  const browser = given || owned;
  try {
    const shell = await loadAndExtract(browser, input, rest.selector, {
      loadW: geo.loadW,
      columnW: geo.columnW,
      background: rest.background,
      contentMaxWidth: rest.contentWidth ?? rest.contentMaxWidth,
      waitFor: rest.waitFor,
      waitTimeout: rest.waitTimeout,
      offline: rest.offline,
      allowNet: rest.allowNet,
    });
    const sections = withPrelude(
      mergeFooter(shell.detection.sections, shell.footerHtml),
      shell.detection.strategy === 'whole-document' ? null : shell.prelude
    );
    const limited = rest.teaser ? sections.slice(0, rest.teaser) : sections;
    const measured = await measureSections(browser, shell.templateHtml, limited, geo, {
      shotDir,
      offline: rest.offline,
      allowNet: rest.allowNet,
    });
    const pages = measured.map((p, i) => ({
      ...judgePage({
        index: i + 1,
        sectionId: p.id,
        contentHeightPx: p.contentHeightPx,
        usableHeightPx: p.usableHeightPx,
        scaleApplied: p.scaleUsed,
        widthScale: p.widthScaleUsed,
        lastBlockKind: p.lastBlockKind,
        keptTogether: true, // section layout cannot split a block
      }),
      title: p.title,
      heightPx: p.heightPx,
      shot: p.shot ? path.basename(p.shot) : null,
    }));
    const quality = summarizeQuality(pages, { targetFill: rest.targetFill });
    const audit = {
      ...shell.audit,
      brokenImages: measured.flatMap((p, i) => (p.brokenImages || []).map((b) => ({ ...b, page: i + 1 }))),
    };
    const lint = lintDocument({
      input,
      pages,
      quality,
      geometry: geo,
      layoutWidthPx: shell.contentMaxWidth,
      requestedLayoutWidthPx: shell.contentWidthRequested,
      audit,
      targetFill: rest.targetFill,
    });
    return {
      input,
      strategy: shell.detection.strategy,
      confidence: shell.detection.confidence,
      background: shell.background,
      contentMaxWidth: shell.contentMaxWidth,
      geometry: geo,
      sheet: sheetSizePx(geo),
      quality,
      qualityLine: formatQualityLine(quality),
      pages,
      findings: lint.findings,
      summary: summarizeLint([lint]),
      generatedAt: new Date().toISOString(),
    };
  } finally {
    if (owned) await browser.close();
  }
}

/**
 * The preview page: vanilla JS, no build step, no dependency.
 * Pure string builder so the shape is testable without a server.
 * @param {object} [opts] { title }
 * @returns {string} HTML
 */
export function previewPage(opts = {}) {
  const title = opts.title || 'tympan preview';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --line: #8884; --ink: #111; --paper: #fff; }
  @media (prefers-color-scheme: dark) { :root { --ink: #eee; --paper: #1b1b1f; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 system-ui, sans-serif; color: var(--ink); display: flex; }
  #side { width: 320px; height: 100vh; overflow-y: auto; padding: 16px; border-right: 1px solid var(--line); position: sticky; top: 0; }
  #stage { flex: 1; padding: 24px; display: flex; flex-direction: column; align-items: center; gap: 24px; background: #6661; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  .path { font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all; color: #888; margin-bottom: 12px; }
  .slot { position: relative; flex: none; }
  .sheet { position: absolute; top: 0; left: 0; transform-origin: top left; background: var(--paper); box-shadow: 0 2px 12px #0003; }
  .sheet img { display: block; position: absolute; left: 50%; transform-origin: top center; }
  .sheet .usable { position: absolute; border: 1px dashed #dc2626aa; pointer-events: none; }
  .sheet .break { position: absolute; left: 0; right: 0; border-top: 2px solid #dc2626; pointer-events: none; }
  .sheet .tag { position: absolute; right: 6px; font: 11px/1.4 ui-monospace, monospace; background: #000000cc; color: #fff; padding: 2px 6px; border-radius: 3px; }
  .sheet .no { top: 6px; left: 6px; }
  .sheet .fill { top: 6px; right: 6px; }
  .sheet .stranded { bottom: 6px; left: 6px; background: #b45309ee; }
  .sheet .off { display: none; }
  .finding { border-left: 3px solid #888; padding: 2px 0 2px 8px; margin: 8px 0; font-size: 12px; }
  .finding.error { border-color: #dc2626; }
  .finding.warning { border-color: #d97706; }
  .finding.note { border-color: #2563eb; }
  .finding code { font-size: 11px; color: #888; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 12px 0; font-size: 12px; }
  dt { color: #888; }
  dd { margin: 0; }
  button { font: inherit; padding: 6px 10px; cursor: pointer; }
  .muted { color: #888; font-size: 12px; }
  /* A narrow window (a side panel, a half-screen terminal) gets the findings
     above the sheets instead of a 320px strip of unreadable text. */
  @media (max-width: 900px) {
    body { flex-direction: column; }
    #side { width: 100%; height: auto; position: static; border-right: 0; border-bottom: 1px solid var(--line); }
    #stage { padding: 16px; }
  }
</style>
</head>
<body>
<div id="side">
  <h1>tympan preview</h1>
  <div class="path" id="input"></div>
  <div id="summary" class="muted">measuring…</div>
  <div style="display:flex;gap:8px;margin:10px 0">
    <button id="refresh">Re-measure</button>
    <button id="toggle">Overlay on/off</button>
  </div>
  <dl id="facts"></dl>
  <div id="findings"></div>
</div>
<div id="stage"></div>
<script>
  const el = (id) => document.getElementById(id);
  let overlay = true;
  let lastReport = null;
  const px = (n) => Math.round(n) + 'px';
  const pct = (n) => Math.round(n * 100) + '%';

  function sheetFor(page, report) {
    const { sheet, geometry } = report;
    const wrap = document.createElement('div');
    wrap.className = 'sheet';
    wrap.style.width = px(sheet.w);
    wrap.style.height = px(sheet.h);
    wrap.style.background = report.background || 'var(--paper)';
    const ml = geometry.margins.left * 96;
    const mt = geometry.margins.top * 96;
    const usableW = (geometry.W_IN - geometry.margins.left - geometry.margins.right) * 96;
    const usableH = (geometry.H_IN - geometry.margins.top - geometry.margins.bottom) * 96;

    if (page.shot) {
      const img = document.createElement('img');
      img.src = '/sheets/' + page.shot;
      img.loading = 'lazy';
      // The printer scales the whole section to fit; show the page the way it
      // will land, anchored at the top of the text area.
      img.style.top = px(mt);
      img.style.width = px(report.contentMaxWidth * page.scaleApplied);
      img.style.transform = 'translateX(-50%)';
      wrap.appendChild(img);
    }

    const usable = document.createElement('div');
    usable.className = 'usable';
    usable.style.left = px(ml);
    usable.style.top = px(mt);
    usable.style.width = px(usableW);
    usable.style.height = px(usableH);
    wrap.appendChild(usable);

    // Where the content stops: the fill line, so the blank tail is visible.
    const end = document.createElement('div');
    end.className = 'break';
    // The image is shown at contentMaxWidth * scaleApplied, and its own pixels
    // are heightPx tall, so its rendered height IS the measured content height.
    // The line therefore lands where the content will stop on the sheet.
    end.style.top = px(mt + Math.min(usableH, page.contentHeightPx));
    wrap.appendChild(end);

    const no = document.createElement('span');
    no.className = 'tag no';
    no.textContent = 'page ' + page.index + ' · ' + (page.sectionId || 'section');
    const fill = document.createElement('span');
    fill.className = 'tag fill';
    fill.textContent = 'fill ' + pct(page.fillRatio) + ' · scale ' + pct(page.scaleApplied);
    wrap.append(no, fill);
    if (page.strandedHeading) {
      const s = document.createElement('span');
      s.className = 'tag stranded';
      s.textContent = 'ends on a heading';
      wrap.appendChild(s);
    }
    return wrap;
  }

  function render(report) {
    el('input').textContent = report.input;
    el('summary').textContent = report.qualityLine;
    const f = el('facts');
    f.innerHTML = '';
    const facts = [
      ['sheet', Math.round(report.geometry.W_IN * 96) + '×' + Math.round(report.geometry.H_IN * 96) + 'px'],
      ['layout width', report.contentMaxWidth + 'px'],
      ['detected via', report.strategy],
      ['sections', String(report.pages.length)],
    ];
    for (const [k, v] of facts) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      f.append(dt, dd);
    }
    const stage = el('stage');
    stage.innerHTML = '';
    for (const page of report.pages) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.appendChild(sheetFor(page, report));
      stage.appendChild(slot);
    }
    fitSheets(report);
    const find = el('findings');
    find.innerHTML = '';
    if (!report.findings.length) {
      find.innerHTML = '<div class="muted">No findings. Every page is at or above the fill target.</div>';
    }
    for (const finding of report.findings) {
      const div = document.createElement('div');
      div.className = 'finding ' + finding.severity;
      div.innerHTML = '<code>' + finding.rule + '</code><br>';
      div.appendChild(document.createTextNode(finding.message));
      find.appendChild(div);
    }
  }

  // Sheets are paper-sized (794x1123 CSS px for A4); a narrow window would
  // otherwise force horizontal scrolling on the thing you are trying to read.
  // Scaling is display-only: the overlay math stays in page units.
  function fitSheets(report) {
    const stage = el('stage');
    const avail = Math.max(240, stage.clientWidth - 48);
    const fit = Math.max(0.2, Math.min(1, avail / report.sheet.w));
    for (const slot of stage.querySelectorAll('.slot')) {
      slot.style.width = px(report.sheet.w * fit);
      slot.style.height = px(report.sheet.h * fit);
      if (slot.firstChild) slot.firstChild.style.transform = 'scale(' + fit + ')';
    }
  }
  window.addEventListener('resize', () => { if (lastReport) fitSheets(lastReport); });

  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.event === 'report') {
      if (msg.error) { el('summary').textContent = 'error: ' + msg.error; return; }
      lastReport = msg.report;
      render(msg.report);
    } else if (msg.event === 'measuring') {
      el('summary').textContent = 're-measuring…';
    }
  };
  el('refresh').onclick = () => fetch('/refresh', { method: 'POST' });
  el('toggle').onclick = () => {
    overlay = !overlay;
    for (const node of document.querySelectorAll('.usable, .break')) node.style.display = overlay ? '' : 'none';
  };
</script>
</body>
</html>`;
}

/**
 * Content type for a served file, by extension. Unknown types are served as
 * octet-stream rather than guessed (no sniffing surprises).
 */
export function contentTypeFor(file) {
  const ext = path.extname(String(file)).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.htm': 'text/html; charset=utf-8',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.json': 'application/json; charset=utf-8',
    }[ext] || 'application/octet-stream'
  );
}

/**
 * Start the preview server.
 *
 * The first measurement happens before the server answers anything, so the URL
 * it prints is already meaningful. The input file is polled: save it and the
 * page re-measures and redraws.
 *
 * @param {object} options { input, port, ...convert options }
 * @returns {Promise<{url: string, port: number, refresh: Function, close: Function,
 *   report: () => object|null}>}
 */
export async function createPreviewServer(options = {}) {
  const input = path.resolve(options.input);
  const shotDir = options.shotDir || fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-preview-'));
  const ownsShotDir = !options.shotDir;
  const state = { report: null, error: null };
  const clients = new Set();
  let browser = null;
  let lastSig = null;
  let busy = null;

  const send = (payload) => {
    for (const res of clients) {
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        /* a dropped client is not an error */
      }
    }
  };

  const refresh = async (why = 'manual') => {
    if (busy) return busy; // one measurement at a time; a save storm must not stack
    busy = (async () => {
      send({ event: 'measuring', why });
      try {
        const stat = fs.statSync(input);
        lastSig = stat.mtimeMs + ':' + stat.size;
        state.report = await buildPreviewReport({ ...options, input, browser, shotDir });
        state.error = null;
      } catch (e) {
        state.error = (e && e.message) || String(e);
      } finally {
        busy = null;
        send({ event: 'report', report: state.report, error: state.error });
      }
    })();
    return busy;
  };

  // A warm browser is reused across reloads: re-measuring a saved file should
  // feel instant, and launching Chromium is the slow part.
  browser = await chromium.launch(launchOptions(options));
  await refresh('initial');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      const page = previewPage({ title: `tympan preview — ${path.basename(input)}` });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      clients.add(res);
      res.write(`data: ${JSON.stringify({ event: 'report', report: state.report, error: state.error })}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/refresh') {
      await refresh('requested');
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    const sheet = /^\/sheets\/([^/]+)$/.exec(url.pathname);
    if (sheet) {
      // A malformed %-sequence in the sheet name must answer 400, not crash
      // this async handler as an unhandled rejection.
      let name;
      try {
        name = path.basename(decodeURIComponent(sheet[1]));
      } catch {
        res.writeHead(400);
        res.end('malformed sheet name');
        return;
      }
      const file = path.join(shotDir, name);
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        res.end('no such sheet');
        return;
      }
      res.writeHead(200, { 'content-type': contentTypeFor(file), 'cache-control': 'no-store' });
      res.end(fs.readFileSync(file));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  const port = options.port ?? PREVIEW_DEFAULT_PORT;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;

  // Poll the input (fs.watch is unreliable across editors and platforms).
  const poll = setInterval(() => {
    try {
      const stat = fs.statSync(input);
      const sig = stat.mtimeMs + ':' + stat.size;
      if (sig !== lastSig) refresh('changed');
    } catch {
      /* the file is being rewritten; the next tick will see it */
    }
  }, 700);
  poll.unref?.();

  const close = async () => {
    clearInterval(poll);
    for (const res of clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    clients.clear();
    await new Promise((resolve) => server.close(resolve));
    if (browser) await browser.close();
    if (ownsShotDir) fs.rmSync(shotDir, { recursive: true, force: true });
  };

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    refresh,
    close,
    report: () => state.report,
  };
}
