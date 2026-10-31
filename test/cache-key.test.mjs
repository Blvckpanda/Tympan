/**
 * cache-key.test.mjs — pins the input digest to actually carry its options.
 *
 * The flow-options hash line in pipeline.js once sat INSIDE the comment above
 * it, so --flow, --page-numbers and fill presets never reached the digest and
 * two competing configurations could report the same input hash. These are
 * the pins against that regression. hashInput is pure, so nothing here needs
 * Chromium — and section-mode digests are unchanged by construction: the
 * flow line only runs when flow is on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashInput } from '../src/pipeline.js';

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-hash-'));
  const file = path.join(dir, 'doc.html');
  fs.writeFileSync(file, '<main><section><p>x</p></section></main>');
  return file;
};

test('hashInput: stable for the same options, digest-length hex', () => {
  const file = tmp();
  const a = hashInput(file, {});
  const b = hashInput(file, {});
  assert.equal(a, b, 'same input + same options = same digest');
  assert.match(a, /^[0-9a-f]{16}$/);
});

test('hashInput: --flow reaches the digest', () => {
  const file = tmp();
  assert.notEqual(hashInput(file, {}), hashInput(file, { flow: true }));
});

test('hashInput: --page-numbers under flow reaches the digest', () => {
  const file = tmp();
  assert.notEqual(hashInput(file, { flow: true }), hashInput(file, { flow: true, pageNumbers: true }));
});

test('hashInput: fill presets reach the digest', () => {
  const file = tmp();
  assert.notEqual(hashInput(file, {}), hashInput(file, { fill: 'tight' }));
  assert.notEqual(hashInput(file, { fill: 'balanced' }), hashInput(file, { fill: 'tight' }));
});

test('hashInput: same input content, different files, same digest', () => {
  const a = tmp();
  const b = tmp();
  // The digest is over the file CONTENT, not the path: that is what makes the
  // determinism claim meaningful across machines. URLs are named instead.
  assert.equal(hashInput(a, { flow: true }), hashInput(b, { flow: true }));
});
