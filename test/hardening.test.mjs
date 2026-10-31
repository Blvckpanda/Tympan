/**
 * hardening.test.mjs — the security and crash pins from the 0.8.0 audit.
 *
 * All of these ran as real exploits or crashes before the fix:
 *   - one malformed-Host request crashed the whole `serve` process;
 *   - `tympan-ui` accepted a no-preflight hostile-page POST and returned a
 *     rendered local file to a rebinding page (forged Host + Origin, no
 *     session token, no content-type check);
 *   - a null targetFill silently disabled lint's underfilled rule.
 * Raw `http.request` is used where `fetch` cannot forge a Host header.
 * (Not in serve.test.mjs: that file assumes fetch() semantics throughout.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lintDocument } from '../src/lint.js';
import { createServeServer } from '../src/serve.js';
import { createUiServer } from '../src/ui/server.js';

/* ------------------------------------------------------------------ lint */

const GEO = {
  W_IN: 8.27,
  H_IN: 11.69,
  contentW: 774,
  margins: { top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 },
};
const sparseSectionPage = () => ({
  index: 1,
  sectionId: 'section-1',
  contentHeightPx: 200,
  usableHeightPx: 1045,
  blankTailPx: 845,
  fillRatio: 0.2,
  scaleApplied: 1,
  widthScale: 1,
  scaledFor: 'none',
  underfilled: true,
  strandedHeading: false,
  keptTogether: true,
  lastBlockKind: 'text',
});
const countRule = (report, rule) => report.findings.filter((f) => f.rule === rule).length;

test('lint: targetFill null falls back to the 0.7 default instead of turning the rule off', () => {
  // Number(null) === 0, so a null target used to slip through as "target 0"
  // and the underfilled rule never fired.
  const ctx = (targetFill) => ({ input: 'x.html', pages: [sparseSectionPage()], geometry: GEO, targetFill });
  assert.equal(countRule(lintDocument(ctx(null)), 'page-underfilled'), 1, 'null targetFill must use the 0.7 default, not 0');
});

test('lint: undefined targetFill keeps the 0.7 default', () => {
  assert.equal(countRule(lintDocument({ input: 'x.html', pages: [sparseSectionPage()], geometry: GEO }), 'page-underfilled'), 1);
});

test('lint: an explicit 0 still turns the fill rule OFF (documented behavior)', () => {
  assert.equal(countRule(lintDocument({ input: 'x.html', pages: [sparseSectionPage()], geometry: GEO, targetFill: 0 }), 'page-underfilled'), 0);
});

/* ------------------------------------------------- serve crash regression */

/**
 * Raw request — fetch() cannot forge a Host header, and a plain request with
 * NO Host header at all is refused by Node's own parser (v24+ HTTP/1.1
 * conformance), so the SSE "headers only" probe always sends a valid one.
 */
function request(port, { method = 'GET', path: reqPath = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: reqPath, headers, setHost: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const RAW_KEYS = new Set(['raw-token-0123456789abcdef']);
const rawConvert = async (htmlText) => ({ master: '/work/x.pdf', text: htmlText });

test('serve: a malformed Host header answers 400 and does NOT kill the process', async () => {
  const api = await createServeServer({
    port: 0,
    keys: RAW_KEYS,
    convertImpl: rawConvert,
    workdir: fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-hard-serve-')),
  });
  const port = api.port;
  let res = null;
  try {
    res = await request(port, { path: '/healthz', headers: { host: 'bad host:9' } });
    assert.equal(res.status, 400, 'a malformed Host is a client error, not a crash');
    // The process survived (a pre-fix crash would have ended it — and with it
    // this test run): a normal request still answers once the 400 is done.
    const after = await fetch(`${api.url}/healthz`);
    assert.equal(after.status, 200);
  } finally {
    await api.close();
  }
});

/* --------------------------------------------------------------- tympan-ui */

const TOKEN = 'test-token-0123456789abcdef';

/** Starts the UI server with a known token; returns { server, port, url }. */
async function startUi() {
  const server = createUiServer({ token: TOKEN });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

/** settleServer: expect + close the sockets the gates keep open, then close. */
function settleServer(server, { keepAlive = 0 } = {}) {
  return new Promise((resolve) => {
    try {
      server.closeAllConnections?.();
    } catch { /* sockets already gone */ }
    if (keepAlive > 0) setTimeout(resolve, keepAlive);
    server.close(() => resolve());
  });
}

const rawUi = (port, opts) => request(port, opts);

test('serve: uiToken is exposed for the bin to print and tests to use', async () => {
  const { server } = await startUi();
  try {
    assert.equal(server.uiToken, TOKEN);
  } finally {
    await settleServer(server);
  }
});

test('tympan-ui: every route requires the per-session token', async () => {
  const { server, port, url } = await startUi();
  try {
    // No key.
    assert.equal((await fetch(url, { headers: { connection: 'close' } })).status, 403);
    // Wrong key.
    assert.equal((await fetch(`${url}/?key=wrong`, { headers: { connection: 'close' } })).status, 403);
    // So are the read-back routes a rebinding page would want:
    assert.equal((await fetch(`${url}/pdf`, { headers: { connection: 'close' } })).status, 403);
    assert.equal((await fetch(`${url}/events`, { headers: { connection: 'close' } })).status, 403);
    assert.equal(
      (await fetch(`${url}/convert`, { method: 'POST', body: '{}', headers: { connection: 'close' } })).status,
      403,
    );
    assert.equal(
      (await fetch(`${url}/watch`, { method: 'POST', body: '{}', headers: { connection: 'close' } })).status,
      403,
    );
    // The UI page works with the key and embeds it for its own requests.
    const page = await fetch(`${url}/?key=${TOKEN}`, { headers: { connection: 'close' } });
    assert.equal(page.status, 200);
    const text = await page.text();
    assert.match(text, /tympan ui/);
    assert.ok(text.includes(TOKEN), 'the page carries its own key in the client code');
  } finally {
    await settleServer(server);
  }
});

test('tympan-ui: a forged foreign Host is refused even WITH a valid token', async () => {
  const { server, port } = await startUi();
  try {
    const res = await rawUi(port, { path: `/?key=${TOKEN}`, headers: { host: 'evil.example:443' } });
    assert.equal(res.status, 403, 'the DNS-rebinding Host shape must not pass');
    // A trailing dot on the loopback name still passes (it is the same host).
    const dot = await rawUi(port, { path: `/?key=${TOKEN}`, headers: { host: `127.0.0.1.:${port}` } });
    assert.equal(dot.status, 200);
  } finally {
    await settleServer(server);
  }
});

test('tympan-ui: the /pdf read-back, the SSE stream and a non-JSON POST are gated', async () => {
  const { server, port, url } = await startUi();
  let sseSocket = null;
  try {
    // /pdf is reachable with the key but honestly says "nothing converted".
    const pdf = await fetch(`${url}/pdf?key=${TOKEN}`, { headers: { connection: 'close' } });
    assert.equal(pdf.status, 404);

    // SSE: the page itself may open the stream (resolve on headers only, then
    // destroy from the client side so no socket lingers past the test).
    await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: `/events?key=${TOKEN}`, setHost: false,
          headers: { host: `127.0.0.1:${port}` } },
        (res) => {
          try {
            assert.equal(res.statusCode, 200, 'the page itself may open the stream');
          } catch (e) {
            reject(e);
          }
          req.destroy();
          resolve();
        },
      );
      sseSocket = req;
      req.on('error', () => { /* the destroy above lands here: expected */ });
      req.end();
    });

    // POST bodies must BE application/json — the no-preflight shapes a hostile
    // page can send (text/plain, or no content-type at all) get 415.
    const noType = await rawUi(port, {
      method: 'POST',
      path: `/convert?key=${TOKEN}`,
      headers: { host: `127.0.0.1:${port}` },
      body: '{"html":"<p>x</p>"}',
    });
    assert.equal(noType.status, 415);
    const plain = await rawUi(port, {
      method: 'POST',
      path: `/convert?key=${TOKEN}`,
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'text/plain' },
      body: '{"html":"<p>x</p>"}',
    });
    assert.equal(plain.status, 415);

    // With the right content-type, the body is parsed and the contract error
    // is the real one (nothing converted yet) — no browser was launched.
    const empty = await fetch(`${url}/convert?key=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: '{}',
    });
    assert.equal(empty.status, 400);
    assert.match((await empty.json()).error, /html or a valid path/);
  } finally {
    if (sseSocket) {
      try { sseSocket.destroy(); } catch { /* already gone */ }
    }
    // The SSE stream takes one loop tick to notice the destroyed socket.
    await settleServer(server, { keepAlive: 20 });
  }
});

test('tympan-ui: /watch passes the full gate with a real file (no Chromium needed)', async () => {
  const { server, port, url } = await startUi();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-ui-watch-')), 'doc.html');
  fs.writeFileSync(file, '<main><section><p>x</p></section></main>');
  try {
    const res = await fetch(`${url}/watch?key=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({ path: file }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.watching, file);
  } finally {
    await settleServer(server);
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});
