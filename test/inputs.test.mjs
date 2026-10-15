/**
 * inputs.test.mjs — v0.7 input plumbing: glob expansion and CLI arg parsing.
 *
 * Both modules are pure (no browser, no process), so these run everywhere.
 * They pin the semantics the batch work depends on: which arguments are
 * inputs and which are flag values, and what a pattern matches.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isGlobPattern, isUrlInput, matchGlob, expandGlob, expandInputs } from '../src/glob.js';
import { parseArgv } from '../src/argv.js';

/** A small tree: two top-level pages, a nested page, noise, a decoy extension. */
function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-glob-'));
  const put = (rel, body = '<p>x</p>') => {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  };
  put('a.html');
  put('b.html');
  put('sub/c.html');
  put('sub/deep/d.html');
  put('skip/e.htmlx');
  put('notes.txt');
  return root;
}

/** Compare expansions by their paths relative to root (separator-agnostic). */
function rel(root, abs) {
  return abs.map((p) => path.relative(root, p).split(path.sep).join('/'));
}

test('isGlobPattern: only real metacharacters count', () => {
  assert.equal(isGlobPattern('docs/*.html'), true);
  assert.equal(isGlobPattern('page-?.html'), true);
  assert.equal(isGlobPattern('[ab].html'), true);
  assert.equal(isGlobPattern('deck.html'), false);
  assert.equal(isGlobPattern('C:/Users/pc/deck.html'), false);
});

test('matchGlob: *, ?, classes and **', () => {
  assert.equal(matchGlob('docs/*.html', 'docs/a.html'), true);
  assert.equal(matchGlob('docs/*.html', 'docs/a/b.html'), false, '* never crosses a separator');
  assert.equal(matchGlob('docs/**/*.html', 'docs/a/b/c.html'), true);
  assert.equal(matchGlob('docs/**/*.html', 'docs/a.html'), true, '** matches zero segments');
  assert.equal(matchGlob('docs/*.html', 'docs\\a.html'), true, 'either separator on input');
  assert.equal(matchGlob('page-?.html', 'page-1.html'), true);
  assert.equal(matchGlob('page-?.html', 'page-10.html'), false);
  assert.equal(matchGlob('[ab].html', 'b.html'), true);
  assert.equal(matchGlob('[!a].html', 'b.html'), true);
  assert.equal(matchGlob('[!a].html', 'a.html'), false);
  assert.equal(matchGlob('*.html', 'a.html'), true);
  assert.equal(matchGlob('*.html', 'a.htmlx'), false);
});

test('expandGlob: sorted absolute paths, decoys excluded, zero matches is empty', () => {
  const root = tree();
  try {
    assert.deepEqual(rel(root, expandGlob('*.html', root)), ['a.html', 'b.html']);
    assert.deepEqual(rel(root, expandGlob('[ab].html', root)), ['a.html', 'b.html']);
    assert.deepEqual(rel(root, expandGlob('?.html', root)), ['a.html', 'b.html']);
    assert.deepEqual(rel(root, expandGlob('sub/*.html', root)), ['sub/c.html']);
    assert.deepEqual(rel(root, expandGlob('sub/**/*.html', root)), ['sub/c.html', 'sub/deep/d.html']);
    assert.deepEqual(rel(root, expandGlob('**/*.html', root)), ['a.html', 'b.html', 'sub/c.html', 'sub/deep/d.html']);
    assert.deepEqual(expandGlob('nowhere/*.html', root), []);
    assert.deepEqual(expandGlob('nope', root), [], 'a literal path is not a pattern');
    // Absolute patterns keep working (the CLI never re-relativizes inputs).
    assert.deepEqual(rel(root, expandGlob(path.join(root, 'sub', '*.html'))), ['sub/c.html']);
    // Sorting makes batch order independent of readdir().
    const again = rel(root, expandGlob('**/*.html', root));
    assert.deepEqual(again, rel(root, expandGlob('**/*.html', root)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('expandInputs: URLs survive verbatim (no resolution, no globbing)', () => {
  // path.resolve would turn a URL into `…/http:/host/doc.html`, and a query
  // string's `?` would read as a wildcard: both must reach the pipeline whole.
  assert.equal(isUrlInput('https://example.test/a.html'), true);
  assert.equal(isUrlInput('file:///tmp/a.html'), true);
  assert.equal(isUrlInput('docs/a.html'), false);
  const { inputs, unmatched } = expandInputs(['https://example.test/deck.html?v=2', 'docs/a.html'], {
    cwd: os.tmpdir(),
  });
  assert.deepEqual(inputs, ['https://example.test/deck.html?v=2', path.join(os.tmpdir(), 'docs', 'a.html')]);
  assert.deepEqual(unmatched, []);
});

test('expandInputs: literals pass through, globs expand in place, duplicates collapse', () => {
  const root = tree();
  try {
    const a = path.join(root, 'a.html');
    const { inputs, unmatched } = expandInputs([path.join(root, '*.html'), a, 'gone/*.html'], { cwd: root });
    assert.deepEqual(rel(root, inputs), ['a.html', 'b.html'], 'a.html is not converted twice');
    assert.deepEqual(unmatched, ['gone/*.html'], 'a pattern with zero matches is reported, not dropped');

    const literal = expandInputs(['sub/*.html'], { cwd: root });
    assert.deepEqual(rel(root, literal.inputs), ['sub/c.html']);
    // A literal that does not exist is NOT a pattern error — the caller
    // reports it as a missing input, which is a better message.
    const missing = expandInputs(['missing.html'], { cwd: root });
    assert.deepEqual(missing.unmatched, []);
    assert.deepEqual(rel(root, missing.inputs), ['missing.html']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const SPEC = {
  valued: ['-o', '--out', '--probe'],
  repeatable: ['--allow-net'],
  boolean: ['--json', '--quiet', '-h'],
};

test('parseArgv: values, booleans, repeatables, positionals', () => {
  const p = parseArgv(['a.html', 'b.html', '-o', 'out', '--probe', 'hello world', '--json'], SPEC);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.positionals, ['a.html', 'b.html'], 'both inputs survive');
  assert.equal(p.value('-o'), 'out');
  assert.equal(p.value('--probe'), 'hello world');
  assert.equal(p.has('--json'), true);
  assert.equal(p.has('--outline'), false);
});

test('parseArgv: - is stdin, not a flag; -- ends flag parsing', () => {
  const stdin = parseArgv(['-', '-o', 'out.pdf'], SPEC);
  assert.deepEqual(stdin.errors, []);
  assert.deepEqual(stdin.positionals, ['-']);
  assert.equal(stdin.value('-o'), 'out.pdf');

  const dashed = parseArgv(['--', '--weird-name.html'], SPEC);
  assert.deepEqual(dashed.errors, []);
  assert.deepEqual(dashed.positionals, ['--weird-name.html']);
});

test('parseArgv: --flag=value, and a value starting with - needs the = form', () => {
  assert.equal(parseArgv(['--probe=-not-a-flag'], SPEC).value('--probe'), '-not-a-flag');
  assert.equal(parseArgv(['--out=deck.pdf'], SPEC).value('--out'), 'deck.pdf');

  // A following flag is never swallowed as the value: `--probe --json`
  // reports the missing value and still applies --json.
  const spaced = parseArgv(['--probe', '--json'], SPEC);
  assert.deepEqual(spaced.errors, ['missing value for --probe']);
  assert.equal(spaced.value('--probe'), undefined);
  assert.equal(spaced.has('--json'), true, 'the following flag still applies');
  assert.ok(parseArgv(['--probe', '-x'], SPEC).errors.includes('missing value for --probe'));
});

test('parseArgv: repeatable flags accumulate; unknown/missing are errors', () => {
  const p = parseArgv(['--allow-net', 'a.test', '--allow-net=b.test'], SPEC);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.list('--allow-net'), ['a.test', 'b.test']);

  assert.deepEqual(parseArgv(['--nope'], SPEC).errors, ['unknown option: --nope']);
  assert.deepEqual(parseArgv(['--out'], SPEC).errors, ['missing value for --out']);
  assert.deepEqual(parseArgv(['--json=1'], SPEC).errors, ['--json does not take a value']);
});
