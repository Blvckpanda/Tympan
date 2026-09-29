/**
 * ui/server.js — zero-dependency local preview server for tympan.
 *
 * Serves one inline UI page that:
 *   - accepts pasted HTML or a local file path
 *   - converts it through the real convert() API
 *   - streams per-section progress over Server-Sent Events
 *   - shows the paginated result in the browser's native PDF viewer
 *   - live-reloads: polls the input file and re-converts on change
 *
 * Routes:
 *   GET  /            the UI page
 *   GET  /events      SSE progress stream (one connection per page)
 *   POST /convert     { html } or { path } -> { ok, master, sections }
 *   POST /watch       { path } -> { ok, watching }
 *   GET  /pdf         the latest converted master PDF
 *
 * The out PDF is written into a session temp dir; nothing in the user's
 * project tree is touched.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { convert } from '../index.js';

const PAGE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>tympan ui</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; display: flex; height: 100vh; }
  #pane { width: 380px; padding: 16px; border-right: 1px solid #8884; overflow-y: auto; }
  #preview { flex: 1; }
  iframe { width: 100%; height: 100%; border: 0; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  textarea { width: 100%; height: 160px; font-family: ui-monospace, monospace; font-size: 12px; }
  input[type=text] { width: 100%; padding: 6px; }
  button { padding: 8px 14px; margin-top: 8px; cursor: pointer; }
  #log { font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; margin-top: 12px; }
  .row { margin-bottom: 12px; }
  label { font-size: 13px; color: #888; }
  .state { font-size: 13px; margin-top: 4px; }
</style>
</head>
<body>
  <div id="pane">
    <h1>tympan ui</h1>
    <div class="row">
      <label>Local HTML file (live-reloaded on change)</label><br>
      <input type="text" id="file" placeholder="C:\\\\path\\\\to\\\\deck.html">
      <button id="watch">Watch & convert</button>
      <div class="state" id="watchState"></div>
    </div>
    <div class="row">
      <label>…or paste HTML</label>
      <textarea id="html" placeholder="&lt;main&gt;&lt;section class=&quot;page-section&quot;&gt;…&lt;/section&gt;&lt;/main&gt;"></textarea>
      <button id="convert">Convert</button>
    </div>
    <div class="state" id="status"></div>
    <div id="log"></div>
  </div>
  <div id="preview"><iframe id="pdf" title="PDF preview"></iframe></div>
<script>
  const log = (m) => { document.getElementById('log').textContent += m + '\\n'; };
  const status = (m) => { document.getElementById('status').textContent = m; };
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.event === 'detected') log('detected ' + d.data.sections.length + ' section(s) via ' + d.data.strategy);
    else if (d.event === 'section') log('  section ' + d.data.index + '/' + d.data.total + ' (' + d.data.id + ')');
    else if (d.event === 'pass-done') log('merged ' + d.data.sections + ' page(s)');
    else if (d.event === 'converted') {
      status('done');
      document.getElementById('pdf').src = '/pdf?t=' + Date.now();
    } else if (d.event === 'error') { status('failed: ' + d.data.message); log('ERROR ' + d.data.message); }
  };
  async function convert(body) {
    status('converting…');
    document.getElementById('log').textContent = '';
    const r = await fetch('/convert', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!j.ok) { status('failed: ' + j.error); log('ERROR ' + j.error); }
  }
  document.getElementById('convert').onclick = () => {
    const html = document.getElementById('html').value.trim();
    if (!html) { status('paste some HTML first'); return; }
    convert({ html });
  };
  document.getElementById('watch').onclick = () => {
    const file = document.getElementById('file').value.trim();
    if (!file) { status('enter a file path first'); return; }
    convert({ path: file }).then(() => fetch('/watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file }) }))
      .then((r) => r.json()).then((j) => { document.getElementById('watchState').textContent = j.ok ? 'watching for changes…' : ('watch failed: ' + j.error); });
  };
</script>
</body>
</html>`;

/** JSON response helper. */
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/**
 * Create (not start) the UI server.
 * @param {object} [options]
 * @returns {Promise<import('node:http').Server>}
 */
export function createUiServer(options = {}) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-ui-'));
  const state = {
    master: path.join(workdir, 'out.pdf'),
    ready: false,
    watchPath: null,
    watchMtimeMs: 0,
    watchTimer: null,
    clients: new Set(),
  };

  const emit = (event, data) => {
    const frame = `data: ${JSON.stringify({ event, data })}\n\n`;
    for (const res of state.clients) res.write(frame);
  };

  async function runConvert(inputPath, html) {
    let tempInput = null;
    try {
      if (html != null) {
        tempInput = path.join(workdir, `pasted-${crypto.randomBytes(4).toString('hex')}.html`);
        fs.writeFileSync(tempInput, html);
        inputPath = tempInput;
      }
      const result = await convert(inputPath, {
        out: state.master,
        onProgress: (event, data) => emit(event, data),
      });
      state.ready = true;
      emit('converted', { master: result.master, sections: result.detection.sections.length });
      return { ok: true, master: result.master, sections: result.detection.sections.length };
    } catch (e) {
      emit('error', { message: e && e.message });
      return { ok: false, error: (e && e.message) || String(e) };
    } finally {
      if (tempInput) fs.rmSync(tempInput, { force: true });
    }
  }

  function startWatching(filePath) {
    state.watchPath = filePath;
    state.watchMtimeMs = fs.statSync(filePath).mtimeMs;
    clearInterval(state.watchTimer);
    state.watchTimer = setInterval(() => {
      try {
        const m = fs.statSync(state.watchPath).mtimeMs;
        if (m !== state.watchMtimeMs) {
          state.watchMtimeMs = m;
          emit('reload', { path: state.watchPath });
          runConvert(state.watchPath);
        }
      } catch { /* file vanished mid-save; next tick retries */ }
    }, 600);
  }

  /** Read and parse a JSON body; responds 400 and returns null on garbage. */
  async function readJson(req, res) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64 * 1024 * 1024) {
        res.destroy();
        return null;
      }
    }
    try {
      return JSON.parse(body || '{}');
    } catch {
      json(res, 400, { ok: false, error: 'invalid JSON body' });
      return null;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE);
      } else if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        state.clients.add(res);
        req.on('close', () => state.clients.delete(res));
      } else if (req.method === 'GET' && url.pathname === '/pdf') {
        if (!state.ready || !fs.existsSync(state.master)) {
          return json(res, 404, { error: 'no PDF converted yet' });
        }
        res.writeHead(200, { 'content-type': 'application/pdf' });
        fs.createReadStream(state.master).pipe(res);
      } else if (req.method === 'POST' && url.pathname === '/convert') {
        const payload = await readJson(req, res);
        if (!payload) return;
        const { html, path: filePath } = payload;
        if (html == null && (!filePath || !fs.existsSync(filePath))) {
          return json(res, 400, { ok: false, error: 'provide html or a valid path' });
        }
        return json(res, 200, await runConvert(filePath, html));
      } else if (req.method === 'POST' && url.pathname === '/watch') {
        const payload = await readJson(req, res);
        if (!payload) return;
        const { path: filePath } = payload;
        if (!filePath || !fs.existsSync(filePath)) {
          return json(res, 400, { ok: false, error: 'no such file' });
        }
        startWatching(filePath);
        json(res, 200, { ok: true, watching: filePath });
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      json(res, 500, { error: (e && e.message) || String(e) });
    }
  });

  server.on('close', () => {
    clearInterval(state.watchTimer);
    fs.rmSync(workdir, { recursive: true, force: true });
  });
  return server;
}

/** Parse a port argument the way the bin expects. */
export function parsePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}
