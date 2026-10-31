/**
 * serve.test.mjs — the HTTP API spike.
 *
 * Most of this contract is tested against an INJECTED converter, which is both
 * faster and stricter than going through Chromium: auth, tenant isolation, the
 * caps, the queue's concurrency and the "never a server file path" rule are all
 * server logic, and a fake converter makes them deterministic. One real job
 * then proves the whole path end to end.
 *
 * The security assertions are the point of this file: a key must never see
 * another tenant's work, and a client must never be able to make the server
 * read its own filesystem or raise its own network policy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseApiKeys,
  authorize,
  validateJobRequest,
  publicJob,
  createJobQueue,
  createServeServer,
  servePolicy,
  ALLOWED_JOB_OPTIONS,
} from '../src/serve.js';
import { findChromium } from '../src/browser.js';

const KEY_A = 'k_test_aaaaaaaaaaaaaaaa';
const KEY_B = 'k_test_bbbbbbbbbbbbbbbb';
const KEYS = new Map([
  [KEY_A, 'acme'],
  [KEY_B, 'globex'],
]);
const AUTH_A = { authorization: `Bearer ${KEY_A}` };
const AUTH_B = { 'x-api-key': KEY_B };

/** A converter that writes a PDF-shaped file and returns a small report. */
function fakeConvert(map = new Map()) {
  return async (input, options) => {
    if (options.out) fs.writeFileSync(options.out, Buffer.from('%PDF-1.4\nfake\n'));
    map.set(input, options);
    return {
      quality: {
        pages: 3,
        targetFill: 0.7,
        meanFill: 0.5,
        minFill: 0.3,
        underfilledPages: [2],
        strandedHeadings: [],
        splitKeepTogether: [],
        shrunkPages: [],
        overflowPages: [],
      },
      verification: { ok: true, sectionCount: 3, outputs: [{ file: options.out, pages: 3, expected: 3, pagesOk: true, probeOk: null, sizeBytes: 14 }] },
    };
  };
}

const waitFor = async (fn, ms = 5000) => {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('parseApiKeys: pairs only, whitespace tolerated, junk skipped', () => {
  const keys = parseApiKeys(' k_live_a:acme , k_test_b:globex , ,lonely-key ');
  assert.equal(keys.size, 2);
  assert.equal(keys.get('k_live_a'), 'acme');
  assert.equal(keys.get('k_test_b'), 'globex');
  assert.equal(parseApiKeys('').size, 0);
  assert.equal(parseApiKeys(undefined).size, 0);
});

test('authorize: bearer, x-api-key, wrong key, no key, no keys configured', () => {
  assert.deepEqual(authorize(AUTH_A, KEYS), { ok: true, tenant: 'acme' });
  assert.deepEqual(authorize(AUTH_B, KEYS), { ok: true, tenant: 'globex' });
  assert.deepEqual(authorize({ authorization: `bearer ${KEY_A}` }, KEYS), { ok: true, tenant: 'acme' });
  assert.equal(authorize({ authorization: 'Bearer nope' }, KEYS).ok, false);
  assert.match(authorize({}, KEYS).reason, /missing API key/);
  assert.match(authorize(AUTH_A, new Map()).reason, /no API keys configured/);
  // A key that is a prefix of a real key must not pass.
  assert.equal(authorize({ 'x-api-key': KEY_A.slice(0, -1) }, KEYS).ok, false);
});

test('validateJobRequest: html or url, never a server path, never a policy override', () => {
  assert.equal(validateJobRequest({ html: '<p>x</p>' }).ok, true);
  assert.equal(validateJobRequest({ url: 'https://example.com/a.html' }).ok, true);
  assert.equal(validateJobRequest({ url: 'file:///etc/passwd' }).ok, false);
  assert.equal(validateJobRequest({ html: '<p>x</p>', url: 'https://x/' }).ok, false);
  assert.equal(validateJobRequest({}).ok, false);
  assert.equal(validateJobRequest(null).ok, false);
  assert.equal(validateJobRequest([]).ok, false);
  assert.equal(validateJobRequest({ html: '   ' }).ok, false);

  // The important refusals.
  const asPath = validateJobRequest({ path: '/etc/passwd' });
  assert.equal(asPath.status, 400);
  assert.match(asPath.error, /never a server file path/);
  assert.match(validateJobRequest({ file: '/etc/passwd' }).error, /never a server file path/);
  assert.match(validateJobRequest({ html: '<p>x</p>', surfaces: 3 }).error, /unknown field/);

  // Network policy belongs to the server: a client asking for it is ignored,
  // and the design options it is allowed to set survive.
  const job = validateJobRequest({
    html: '<p>x</p>',
    options: { allowNet: ['*'], offline: true, format: 'letter', margins: { top: 1 }, nope: 1 },
  });
  assert.equal(job.ok, true);
  assert.deepEqual(job.options, { format: 'letter', margins: { top: 1 } });
  assert.equal(ALLOWED_JOB_OPTIONS.includes('allowNet'), false);
  assert.equal(ALLOWED_JOB_OPTIONS.includes('offline'), false);
  assert.equal(validateJobRequest({ html: '<p>x</p>', options: { format: 'A3' } }).options.format, undefined);
});

test('publicJob: no tenant, no paths, no internal fields', () => {
  const job = {
    id: 'job-1',
    tenant: 'acme',
    status: 'done',
    createdAt: 'now',
    input: { kind: 'html', value: '[html]', bytes: 12 },
    options: { format: 'a4' },
    htmlPath: '/tmp/secret.html',
    pdfPath: '/tmp/secret.pdf',
    report: { pages: 1 },
    progress: ['detected'],
  };
  const pub = publicJob(job);
  assert.deepEqual(Object.keys(pub).sort(), ['createdAt', 'id', 'input', 'options', 'pdfUrl', 'progress', 'report', 'status']);
  const text = JSON.stringify(pub);
  assert.doesNotMatch(text, /acme|secret|htmlPath|pdfPath/);
  assert.match(pub.pdfUrl, /^\/v1\/jobs\/job-1\/pdf$/);
  assert.equal(publicJob({ ...job, status: 'queued' }).pdfUrl, undefined);
});

test('createJobQueue: bounded, FIFO, concurrency-limited, failures contained', async () => {
  const order = [];
  let inFlight = 0;
  let peak = 0;
  const queue = createJobQueue({
    concurrency: 2,
    maxQueued: 4, // pending + running, so all three fit
    run: async (job) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      order.push(job.id);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      if (job.id === 'c') throw new Error('cannot convert this');
      return { ok: true };
    },
  });
  const jobs = ['a', 'b', 'c'].map((id) => ({ id, status: 'queued' }));
  for (const job of jobs) assert.equal(queue.enqueue(job), true);
  await queue.idle();
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(peak, 2, 'never more than the configured concurrency');
  assert.equal(jobs[2].status, 'failed');
  assert.match(jobs[2].error, /cannot convert this/);
  assert.equal(jobs[0].status, 'done');
  assert.deepEqual(queue.stats(), { queued: 0, active: 0 });

  // A full queue is refused rather than silently growing: the caller answers 429.
  const full = createJobQueue({ concurrency: 1, maxQueued: 1, run: () => new Promise(() => {}) });
  assert.equal(full.enqueue({ id: 'x', status: 'queued' }), true);
  assert.equal(full.enqueue({ id: 'y', status: 'queued' }), false);
});

test('serve: auth, isolation, caps and the PDF route (injected converter)', async () => {
  const seen = new Map();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-serve-test-'));
  let server;
  try {
    server = await createServeServer({
      port: 0,
      keys: KEYS,
      convertImpl: fakeConvert(seen),
      workdir: path.join(dir, 'work'),
      ttlMs: 60_000,
      concurrency: 1,
      maxJobsPerTenant: 1,
    });
    fs.mkdirSync(path.join(dir, 'work'), { recursive: true });

    const health = await fetch(`${server.url}/healthz`);
    assert.equal(health.status, 200, 'health needs no key');
    assert.equal((await health.json()).ok, true);

    const anon = await fetch(`${server.url}/v1/me`);
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('www-authenticate'), /Bearer/);
    assert.equal((await fetch(`${server.url}/v1/me`, { headers: { authorization: 'Bearer wrong' } })).status, 401);

    const me = await fetch(`${server.url}/v1/me`, { headers: AUTH_A });
    assert.equal(me.status, 200);
    const meBody = await me.json();
    assert.equal(meBody.tenant, 'acme');
    assert.equal(meBody.maxJobs, 1);

    // A path submission is refused, not converted.
    const pathJob = await fetch(`${server.url}/v1/jobs`, {
      method: 'POST',
      headers: { ...AUTH_A, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/etc/passwd' }),
    });
    assert.equal(pathJob.status, 400);
    assert.match((await pathJob.json()).error, /never a server file path/);

    // A real job.
    const posted = await fetch(`${server.url}/v1/jobs`, {
      method: 'POST',
      headers: { ...AUTH_A, 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<main><section class="page-section"><h1>Hello</h1></section></main>', options: { format: 'a4' } }),
    });
    assert.equal(posted.status, 202);
    const job = await posted.json();
    assert.equal(job.status, 'queued');
    assert.equal(job.input, 'html');
    assert.ok(!JSON.stringify(job).includes('secret'));

    const done = await waitFor(async () => {
      const r = await fetch(`${server.url}/v1/jobs/${job.id}`, { headers: AUTH_A });
      const body = await r.json();
      return body.status === 'done' ? body : null;
    });
    assert.equal(done.report.pages, 3);
    assert.match(done.report.qualityLine, /fill:/);
    assert.match(done.pdfUrl, /\/v1\/jobs\/.+\.?.*\/pdf$/);

    const pdf = await fetch(`${server.url}${done.pdfUrl}`, { headers: AUTH_A });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(Buffer.from(await pdf.arrayBuffer()).toString('latin1'), /^%PDF/);

    // Tenant isolation: the other key cannot see it, and is told 404 (not 403 —
    // whether an id exists is itself information).
    assert.equal((await fetch(`${server.url}/v1/jobs/${job.id}`, { headers: AUTH_B })).status, 404);
    assert.equal((await fetch(`${server.url}/v1/jobs/${job.id}/pdf`, { headers: AUTH_B })).status, 404);

    // The per-tenant cap: acme already holds one job (its limit), so the next
    // is refused rather than queued behind it.
    const over = await fetch(`${server.url}/v1/jobs`, {
      method: 'POST',
      headers: { ...AUTH_A, 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>again</p>' }),
    });
    assert.equal(over.status, 429);
    assert.match((await over.json()).error, /too many jobs/);

    // A different tenant is unaffected by acme's cap.
    const other = await fetch(`${server.url}/v1/jobs`, {
      method: 'POST',
      headers: { ...AUTH_B, 'content-type': 'application/json' },
      body: JSON.stringify({ html: '<p>globex</p>' }),
    });
    assert.equal(other.status, 202);

    // Delete releases the job and its bytes.
    const deleted = await fetch(`${server.url}/v1/jobs/${job.id}`, { method: 'DELETE', headers: AUTH_A });
    assert.equal(deleted.status, 200);
    assert.equal((await fetch(`${server.url}/v1/jobs/${job.id}`, { headers: AUTH_A })).status, 404);

    // Unknown routes and methods say what is available.
    const nowhere = await fetch(`${server.url}/v1/nope`, { headers: AUTH_A });
    assert.equal(nowhere.status, 404);
    assert.match((await nowhere.json()).hint, /POST \/v1\/jobs/);
    assert.equal((await fetch(`${server.url}/v1/jobs`, { headers: AUTH_A })).status, 404);

    // The converted options reached the converter with SERVER policy attached.
    const used = [...seen.values()][0];
    assert.ok(used, 'the converter was called');
    assert.equal(used.format, 'a4');
    assert.match(used.out, /\.pdf$/);
  } finally {
    if (server) await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serve: an oversized body is refused before it is parsed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-serve-big-'));
  let server;
  try {
    server = await createServeServer({
      port: 0,
      keys: KEYS,
      convertImpl: fakeConvert(),
      workdir: path.join(dir, 'work'),
      maxBodyBytes: 512,
    });
    fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
    const res = await fetch(`${server.url}/v1/jobs`, {
      method: 'POST',
      headers: { ...AUTH_A, 'content-type': 'application/json' },
      body: JSON.stringify({ html: 'x'.repeat(2048) }),
    });
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /too large/);
  } finally {
    if (server) await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('serve: a real Chromium job produces a real, measured PDF', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-serve-real-'));
  let server;
  try {
    server = await createServeServer({ port: 0, keys: KEYS, workdir: path.join(dir, 'work') });
    fs.mkdirSync(path.join(dir, 'work'), { recursive: true });
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0}main{max-width:774px;margin:0 auto}</style></head>' +
      '<body><main><section class="page-section" id="one"><h1>Chapter one</h1><p>Text.</p></section>' +
      '<section class="page-section" id="two"><h1>Chapter two</h2><p>More.</p></section></main></body></html>';
    const posted = await fetch(`${server.url}/v1/jobs`, {
      method: 'POST',
      headers: { ...AUTH_A, 'content-type': 'application/json' },
      body: JSON.stringify({ html }),
    });
    assert.equal(posted.status, 202);
    const job = await posted.json();
    const done = await waitFor(async () => {
      const body = await (await fetch(`${server.url}/v1/jobs/${job.id}`, { headers: AUTH_A })).json();
      if (body.status === 'failed') throw new Error(`job failed: ${body.error}`);
      return body.status === 'done' ? body : null;
    }, 60_000);
    assert.equal(done.report.pages, 2);
    assert.ok(done.report.sizeBytes > 1000);
    assert.equal(done.report.verification.ok, true);

    const pdf = await fetch(`${server.url}${done.pdfUrl}`, { headers: AUTH_A });
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(bytes.length > 1000);
  } finally {
    if (server) await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('servePolicy: the defaults a deploy is promising', () => {
  const policy = servePolicy();
  assert.equal(policy.concurrency, 2);
  assert.equal(policy.maxJobsPerTenant, 16);
  assert.equal(policy.ttlMs, 15 * 60 * 1000);
  assert.equal(policy.offline, false);
  assert.equal(servePolicy({ concurrency: 4, ttlMs: 1000, offline: true }).concurrency, 4);
});
