/**
 * batch.test.mjs — v0.7 batch/stdin/glob input story, end to end.
 *
 * Argument-level cases run the real CLI and assert exit codes (2 = bad
 * invocation, 1 = conversion/verification failure, 0 = success); browser
 * cases skip cleanly without Chromium. Together they pin:
 *   - several inputs convert through ONE batch (progress proves the path)
 *   - a quoted glob expands in-CLI, and zero matches is an error
 *   - `-` reads the document from stdin (relative refs resolve in cwd)
 *   - `-o -` streams the PDF to stdout, and refuses ambiguity
 *   - multi-input `-o` must be a directory
 *   - a failure mid-batch does not abandon the remaining inputs
 *   - a URL-shaped argument is never looked up on disk
 *
 * URL *conversion* through the CLI is not covered here: this sandbox cannot
 * complete http requests from a nested child process (a child running the
 * library directly hangs identically, with zero requests reaching the server),
 * so such a test would time out on the 120s navigation wait. The in-process
 * URL path is covered by phase1's file://-leak test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { convertMany } from '../src/index.js';
import { buildBatchJsonReport } from '../src/report.js';
import { findChromium } from '../src/browser.js';

const CLI = fileURLToPath(new URL('../bin/tympan.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-batch-'));
}

/** The real CLI, as a user runs it. Encoding null keeps binary stdout intact. */
function tympan(args, options = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...options });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const doc = (title, extra = '') => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0} .page-section{padding:24px}</style></head><body><main>
<section class="page-section"><h2>${title}</h2><p>${extra || 'body copy for ' + title}</p></section>
</main></body></html>`;

/** Two one-page documents plus the directory that holds them. */
function pair() {
  const dir = tmpdir();
  const page = (name, extra) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, doc(name, extra));
    return f;
  };
  return { dir, a: page('a.html'), b: page('b.html') };
}

test('buildBatchJsonReport: every input is accounted for, failures included', () => {
  const ok = { master: '/tmp/a.pdf', detection: { strategy: 'page-section-class', sections: [{}, {}] }, blockedRequests: 0 };
  const report = buildBatchJsonReport({
    ok: false,
    entries: [
      { input: '/tmp/a.html', ok: true, result: ok, error: null },
      { input: '/tmp/b.html', ok: false, result: null, error: 'Input not found: /tmp/b.html' },
    ],
  });
  assert.equal(report.ok, false);
  assert.equal(report.count, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.results[0].ok, true);
  assert.equal(report.results[0].input, '/tmp/a.html');
  assert.equal(report.results[0].detection.sections, 2, 'same per-document shape as the single report');
  assert.deepEqual(report.results[1], { ok: false, input: '/tmp/b.html', error: 'Input not found: /tmp/b.html' });
});

test('CLI: malformed invocations exit 2 with an actionable message', () => {
  const { dir, a, b } = pair();
  const cases = [
    { args: ['--nope', a], expect: /unknown option: --nope/ },
    { args: [a, '--probe'], expect: /missing value for --probe/ },
    { args: ['no-such-dir/*.html'], expect: /no files match: no-such-dir\/\*\.html/ },
    { args: [a, b, '-o', 'out.pdf'], expect: /-o must be a directory/ },
    { args: [a, b, '-o', '-'], expect: /exactly one input/ },
    { args: [a, '-o', '-', '--json'], expect: /both write to stdout/ },
    { args: ['test', a, '--tolerance', '5'], expect: /fraction between 0 and 1/ },
  ];
  try {
    for (const c of cases) {
      const r = tympan(c.args);
      assert.equal(r.code, 2, `expected exit 2 for ${c.args.join(' ')} (stderr: ${r.stderr})`);
      assert.match(r.stderr, c.expect, `message for ${c.args.join(' ')}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: a quoted glob expands; several inputs convert in one batch', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const { dir } = pair();
  try {
    const r = tympan([path.join(dir, '*.html')], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    // Batch progress on stderr is the observable proof that the batch path ran.
    assert.match(r.stderr, /\[1\/2\]/);
    assert.match(r.stderr, /\[2\/2\]/);
    for (const name of ['a.pdf', 'b.pdf']) {
      const f = path.join(dir, name);
      assert.ok(fs.existsSync(f), `${name} must be written next to its input`);
      assert.equal(fs.readFileSync(f).subarray(0, 5).toString(), '%PDF-');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: -o <dir>/ creates the directory and drops every PDF into it', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const { dir } = pair();
  const sep = path.sep;
  try {
    // `-o dist/` on a clean checkout: the separator asks for a directory, and
    // the run must not fail just because nothing created it yet.
    const batch = tympan([path.join(dir, '*.html'), '-o', path.join(dir, 'dist') + sep], { cwd: dir });
    assert.equal(batch.code, 0, batch.stderr);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'dist')).sort(), ['a.pdf', 'b.pdf']);

    // One input into a directory keeps its own name and does not become `dist`.
    const single = tympan(['a.html', '-o', path.join(dir, 'one') + sep], { cwd: dir });
    assert.equal(single.code, 0, single.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'one', 'a.pdf')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: batch --json reports one result per input', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const { dir } = pair();
  try {
    const r = tympan(['a.html', 'b.html', '--json'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.count, 2);
    assert.equal(report.failed, 0);
    assert.deepEqual(
      report.results.map((x) => path.basename(x.input)).sort(),
      ['a.html', 'b.html']
    );
    assert.ok(report.results.every((x) => x.ok && x.master.endsWith('.pdf') && x.verification.ok));
    assert.equal(r.stderr, '', 'progress stays on stderr and is silenced by --json');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: stdin becomes stdin.pdf in the current directory, labelled "-"', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  try {
    const r = tympan(['-', '--json'], { cwd: dir, input: doc('From stdin', 'piped through the CLI') });
    assert.equal(r.code, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.input, '-', 'the scratch file never surfaces in the report');
    assert.equal(report.master, path.join(dir, 'stdin.pdf'));
    assert.equal(fs.readFileSync(report.master).subarray(0, 5).toString(), '%PDF-');
    assert.equal(
      fs.readdirSync(dir).filter((f) => f.startsWith('.tympan-stdin-')).length,
      0,
      'the scratch document is cleaned up'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: -o - streams the PDF to stdout', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const { dir } = pair();
  try {
    const r = tympan(['a.html', '-o', '-'], { cwd: dir, encoding: null });
    assert.equal(r.code, 0, String(r.stderr));
    assert.equal(r.stdout.subarray(0, 5).toString(), '%PDF-');
    assert.ok(r.stdout.length > 1000, 'a whole document, not a header');
    assert.ok(!fs.existsSync(path.join(dir, 'a.pdf')), 'nothing is written to disk behind the user');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --allow-net takes a value, so it never fills the input slot', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const { dir, a } = pair();
  try {
    // The pre-v0.7 parser left `127.0.0.1` unconsumed, so it became the input
    // and the real file was ignored: this is the regression pin for that.
    const r = tympan(['--allow-net', '127.0.0.1', 'a.html', '-o', 'out.pdf'], { cwd: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'out.pdf')), 'the file was converted, not 127.0.0.1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: a file:// URL is named as unsupported, not looked up on disk', () => {
  const r = tympan(['file:///tmp/deck.html']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unsupported URL scheme: file:\/\/\/tmp\/deck\.html/);
  assert.match(r.stderr, /pass a path for local files/);
});

test('library: convertMany contains a failure and still converts the rest', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const dir = tmpdir();
  const missing = path.join(dir, 'gone.html');
  const good = (name) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, doc(name));
    return f;
  };
  const first = good('first.html');
  const third = good('third.html');
  try {
    const batch = await convertMany([first, missing, third], {
      perInput: (input) => ({ out: input.replace(/\.html$/, '.pdf') }),
    });
    assert.equal(batch.ok, false);
    assert.equal(batch.entries.length, 3, 'every input is accounted for');
    assert.deepEqual(
      batch.entries.map((e) => e.ok),
      [true, false, true],
      'a missing file does not abandon the inputs after it'
    );
    assert.match(batch.entries[1].error, /Input not found/);
    assert.ok(fs.existsSync(path.join(dir, 'third.pdf')), 'the later input really converted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
