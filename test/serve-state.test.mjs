/**
 * serve-state.test.mjs — the durable seams of `tympan serve`.
 *
 * docs/SERVE.md's roadmap named three gaps as "before this is a product":
 * a hashed, persistent key store; a queue a restart does not lose; and
 * metering. Each one is proven here against the real seam, not a mock of it:
 *
 *   - keys are written as sha256 digests (the file never contains the
 *     plaintext), authorize() accepts the stored record, wrong keys 401, and
 *     a revocation removes access;
 *   - a job accepted by one server process is finished by the NEXT process
 *     started on the same state dir — including its submitted HTML payload —
 *     and a job that lost its bytes fails with the reason instead of hanging;
 *   - metering counts submissions and outcomes, pages and bytes, and the
 *     journal's record survives restart while a DELETE does not rewrite it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openServeState, hashKey, emptyMeterRow } from '../src/serve-state.js';
import { createServeServer, authorize } from '../src/serve.js';

const CLI = fileURLToPath(new URL('../bin/tympan.js', import.meta.url));
const FAKE_PDF = Buffer.from('%PDF-1.4\nfake\n');

function tmpdir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tympan-${label}-`));
}

/** Converter that writes a small PDF and reports 3 pages, like serve.test's. */
function fakeConvert(seen = []) {
  return async (input, options) => {
    if (options.out) fs.writeFileSync(options.out, FAKE_PDF);
    seen.push({ input, options });
    return {
      quality: { pages: 3, targetFill: 0.7, meanFill: 0.5, minFill: 0.3, underfilledPages: [], strandedHeadings: [], splitKeepTogether: [], shrunkPages: [], overflowPages: [] },
      verification: { ok: true, sectionCount: 3, outputs: [{ file: options.out, pages: 3, expected: 3, pagesOk: true, probeOk: null, sizeBytes: FAKE_PDF.length }] },
    };
  };
}

async function call(url, { method = 'GET', key, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

async function waitFor(url, key, id, want = 'done', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await call(`${url}/v1/jobs/${id}`, { key });
    if (r.json && r.json.status === want) return r.json;
    if (Date.now() > deadline) throw new Error(`job ${id} did not become ${want}: ${JSON.stringify(r.json)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('serve state: keys are stored as sha256 digests and never in plaintext', () => {
  const dir = tmpdir('keys');
  const store = openServeState(dir);
  const secret = 'k_test_persisted_secret_1';
  assert.equal(store.addKey(hashKey(secret), 'acme'), true);
  assert.equal(store.addKey(hashKey(secret), 'acme'), false); // idempotent per hash
  const raw = fs.readFileSync(store.keysFile(), 'utf8');
  assert.ok(raw.includes(hashKey(secret)), 'the digest is on disk');
  assert.ok(!raw.includes(secret), 'the plaintext key is NOT on disk');
  const keys = store.loadKeys();
  assert.equal(keys.length, 1);
  assert.equal(keys[0].tenant, 'acme');
  assert.match(keys[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('serve state: stored hashes authorize, wrong keys 401, revocation removes access', async () => {
  const dir = tmpdir('auth');
  const good = 'k_test_stored_good_1';
  openServeState(dir).addKey(hashKey(good), 'acme');
  const serve = await createServeServer({ port: 0, keys: new Map(), stateDir: dir, convertImpl: fakeConvert() });
  try {
    const me = await call(`${serve.url}/v1/me`, { key: good });
    assert.equal(me.status, 200);
    assert.equal(me.json.tenant, 'acme');
    assert.deepEqual(me.json.meter, emptyMeterRow(), 'a fresh tenant meters at zero');

    const bad = await call(`${serve.url}/v1/me`, { key: 'k_test_stored_good_2' });
    assert.equal(bad.status, 401);

    openServeState(dir).revokeKey(hashKey(good));
    const revoked = await call(`${serve.url}/v1/me`, { key: good });
    assert.equal(revoked.status, 401, 'a revoked key is refused');
  } finally {
    await serve.close();
  }
});

test('serve state: env-configured keys are persisted (hashed) and survive a restart', async () => {
  const dir = tmpdir('persist');
  const secret = 'k_test_env_persist_1';
  const a = await createServeServer({
    port: 0,
    keys: new Map([[secret, 'globex']]),
    stateDir: dir,
    convertImpl: fakeConvert(),
  });
  await a.close();
  const raw = fs.readFileSync(openServeState(dir).keysFile(), 'utf8');
  assert.ok(!raw.includes(secret), 'the env secret was not written in plaintext');

  // A restart with NO env keys at all still authorizes: the store is the source.
  const b = await createServeServer({ port: 0, keys: new Map(), stateDir: dir, convertImpl: fakeConvert() });
  try {
    const me = await call(`${b.url}/v1/me`, { key: secret });
    assert.equal(me.status, 200);
    assert.equal(me.json.tenant, 'globex');
  } finally {
    await b.close();
  }
});

test('serve keys CLI: add, list (no plaintext), revoke by hash prefix', () => {
  const dir = tmpdir('cli-keys');
  const secret = 'k_test_cli_secret_1';
  let r = spawnSync(process.execPath, [CLI, 'serve', 'keys', 'add', `${secret}:acme`, '--state-dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes(secret), 'the CLI does not echo the key back');

  r = spawnSync(process.execPath, [CLI, 'serve', 'keys', 'list', '--state-dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stderr.includes(keyPrefix(secret)), 'the listing names the fingerprint');
  assert.ok(r.stderr.includes('acme'));
  assert.ok(!r.stderr.includes(secret), 'the listing never shows the key');

  r = spawnSync(process.execPath, [CLI, 'serve', 'keys', 'revoke', keyPrefix(secret), '--state-dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(openServeState(dir).loadKeys().length, 0);

  r = spawnSync(process.execPath, [CLI, 'serve', 'keys', 'revoke', keyPrefix(secret), '--state-dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1, 'revoking an absent key is a failure, not a silent success');
});

function keyPrefix(secret) {
  return hashKey(secret).slice(0, 8);
}

test('serve state: a queued job survives restart and finishes with its html payload', async () => {
  const dir = tmpdir('restart');
  const secret = 'k_test_restart_1';
  const keys = new Map([[secret, 'acme']]);

  // First process: job one blocks forever (a stand-in for a killed
  // conversion), job two never starts. close() is the "crash" boundary.
  const a = await createServeServer({
    port: 0,
    keys,
    stateDir: dir,
    concurrency: 1,
    convertImpl: () => new Promise(() => {}), // never resolves: the "killed" conversion
  });
  const got1 = await call(`${a.url}/v1/jobs`, { method: 'POST', key: secret, body: { html: '<html><body><h1>one</h1></body></html>' } });
  assert.equal(got1.status, 202);
  const got2 = await call(`${a.url}/v1/jobs`, { method: 'POST', key: secret, body: { html: '<html><body><h1>two</h1></body></html>' } });
  assert.equal(got2.status, 202);
  // Both are accepted and journalled before the "crash": one row says
  // 'running', the other 'queued', and neither row holds the plaintext key.
  const journal = fs.readdirSync(path.join(dir, 'jobs')).filter((f) => f.endsWith('.json'));
  assert.equal(journal.length, 2, 'one job file per accepted job');
  const rows = journal.map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'jobs', f), 'utf8')));
  assert.deepEqual(rows.map((r) => r.status).sort(), ['queued', 'running']);
  for (const f of journal) assert.ok(!fs.readFileSync(path.join(dir, 'jobs', f), 'utf8').includes(secret));
  await a.close();

  // Second process: same state dir, a converter that finishes.
  const seen = [];
  const b = await createServeServer({ port: 0, keys: new Map(), stateDir: dir, convertImpl: fakeConvert(seen) });
  try {
    const id1 = got1.json.id;
    const id2 = got2.json.id;
    const done = await Promise.all([waitFor(b.url, secret, id1), waitFor(b.url, secret, id2)]);
    assert.equal(done[0].status, 'done');
    assert.equal(done[1].status, 'done');

    const pdf = await call(`${b.url}/v1/jobs/${id1}/pdf`, { key: secret });
    assert.equal(pdf.status, 200);
    assert.match(pdf.text, /^%PDF-1\.4/);

    // The submitted HTML rode along: the converter read the payload file.
    assert.equal(seen.length, 2);
    for (const entry of seen) {
      assert.ok(entry.input.endsWith('.html'));
      assert.match(fs.readFileSync(entry.input, 'utf8'), /<h1>(one|two)<\/h1>/);
    }

    // Metering: submissions were journalled by process one, outcomes by two.
    const me = await call(`${b.url}/v1/me`, { key: secret });
    assert.equal(me.json.meter.submitted, 2);
    assert.equal(me.json.meter.succeeded, 2);
    assert.equal(me.json.meter.failed, 0);
    assert.equal(me.json.meter.pages, 6);
    assert.equal(me.json.meter.bytes, FAKE_PDF.length * 2);

    // And the meter file is the durable record, not the response.
    const persisted = JSON.parse(fs.readFileSync(openServeState(dir).meterFile(), 'utf8'));
    assert.equal(persisted.tenants.acme.succeeded, 2);

    // A DELETE releases the job without rewriting accounting.
    assert.equal((await call(`${b.url}/v1/jobs/${id2}`, { method: 'DELETE', key: secret })).status, 200);
    const after = await call(`${b.url}/v1/me`, { key: secret });
    assert.equal(after.json.meter.succeeded, 2);
  } finally {
    await b.close();
  }
});

test('serve state: incomplete work without its payload fails on restart, with the reason', async () => {
  const dir = tmpdir('lost');
  const store = openServeState(dir);
  // A journal row whose payload never existed (session died mid-write, or an
  // operator moved the dir): the restart must not pretend it can convert.
  store.saveJob({
    id: 'lost-payload-0001',
    tenant: 'acme',
    status: 'queued',
    createdAt: new Date().toISOString(),
    input: { kind: 'html', value: '[html]' },
    options: {},
  });
  // And a finished row whose PDF vanished: honest failure, not a 500 later.
  store.saveJob({
    id: 'lost-result-0002',
    tenant: 'acme',
    status: 'done',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    input: { kind: 'url', value: 'https://example.com/' },
    options: {},
    report: { pages: 1, sizeBytes: 1 },
  });
  const secret = 'k_test_lost_1';
  store.addKey(hashKey(secret), 'acme');
  const serve = await createServeServer({ port: 0, keys: new Map(), stateDir: dir, convertImpl: fakeConvert() });
  try {
    const lost = await call(`${serve.url}/v1/jobs/lost-payload-0001`, { key: secret });
    assert.equal(lost.json.status, 'failed');
    assert.match(lost.json.error, /payload lost on restart/);

    const gone = await call(`${serve.url}/v1/jobs/lost-result-0002`, { key: secret });
    assert.equal(gone.json.status, 'failed');
    assert.match(gone.json.error, /result lost on restart/);

    // A done job that lost its PDF is not served as if it were done.
    const pdf = await call(`${serve.url}/v1/jobs/lost-result-0002/pdf`, { key: secret });
    assert.equal(pdf.status, 409);
  } finally {
    await serve.close();
  }
});

test('serve state: metering counts failures too, and survives restart', async () => {
  const dir = tmpdir('meter');
  const secret = 'k_test_meter_1';
  const keys = new Map([[secret, 'acme']]);
  const ok = fakeConvert();
  let calls = 0;
  const converter = async (input, options) => {
    calls += 1;
    if (calls === 2) throw new Error('boom: converter exploded');
    return ok(input, options);
  };
  const a = await createServeServer({ port: 0, keys, stateDir: dir, convertImpl: converter });
  const r1 = await call(`${a.url}/v1/jobs`, { method: 'POST', key: secret, body: { html: '<p>a</p>' } });
  const r2 = await call(`${a.url}/v1/jobs`, { method: 'POST', key: secret, body: { url: 'https://example.com/' } });
  await waitFor(a.url, secret, r1.json.id);
  const failed = await waitFor(a.url, secret, r2.json.id, 'failed');
  assert.match(failed.error, /boom/);
  const before = (await call(`${a.url}/v1/me`, { key: secret })).json.meter;
  assert.deepEqual(
    { submitted: before.submitted, succeeded: before.succeeded, failed: before.failed, pages: before.pages },
    { submitted: 2, succeeded: 1, failed: 1, pages: 3 }
  );
  assert.ok(before.convertMs >= 0);
  await a.close();

  const b = await createServeServer({ port: 0, keys: new Map(), stateDir: dir, convertImpl: fakeConvert() });
  try {
    const after = (await call(`${b.url}/v1/me`, { key: secret })).json.meter;
    assert.equal(after.submitted, 2, 'submissions survive the restart');
    assert.equal(after.succeeded, 1);
    assert.equal(after.failed, 1);
    assert.equal(after.pages, 3);

    // The next job counts on top, not from zero.
    const r3 = await call(`${b.url}/v1/jobs`, { method: 'POST', key: secret, body: { html: '<p>c</p>' } });
    await waitFor(b.url, secret, r3.json.id);
    const next = (await call(`${b.url}/v1/me`, { key: secret })).json.meter;
    assert.equal(next.submitted, 3);
    assert.equal(next.succeeded, 2);
    assert.equal(next.pages, 6);
  } finally {
    await b.close();
  }
});

test('serve state: authorize() itself accepts a hashed set (no plaintext needed)', () => {
  const hashed = new Map([[hashKey('k_test_hashed_1'), 'acme']]);
  assert.deepEqual(authorize({ authorization: 'Bearer k_test_hashed_1' }, new Map(), hashed), { ok: true, tenant: 'acme' });
  assert.equal(authorize({ authorization: 'Bearer k_test_hashed_2' }, new Map(), hashed).ok, false);
  assert.equal(authorize({}, new Map(), hashed).ok, false);
});
