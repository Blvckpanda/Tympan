/**
 * wide.test.mjs — needs Chromium; converts the wide fixture through convert()
 * and asserts the source container's max-width was detected and used.
 * Skipped automatically when Chromium is unavailable (unit-only checkouts).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/index.js';
import { findChromium } from '../src/browser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'ai-deck-wide.html');

test('detects and applies the source container max-width (wide fixture)', { skip: !findChromium() ? 'Chromium not available' : false }, async (t) => {
  const out = path.join(here, 'out', 'wide.pdf');
  const result = await convert(fixture, { out, verify: false });
  try {
    assert.equal(result.contentMaxWidth, 1100);
    assert.equal(result.detection.sections.length, 2);
  } finally {
    for (const f of [result.master, result.email].filter(Boolean)) {
      await fs.promises.rm(f, { force: true });
    }
  }
});
