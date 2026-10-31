/**
 * wide.test.mjs — needs Chromium; converts the wide fixture through convert()
 * and asserts the source container's max-width was detected and applied.
 * Skipped automatically when Chromium is unavailable (unit-only checkouts).
 *
 * The fixture asks for 1100px. Detection must still SEE that request, and the
 * applied layout must not exceed A4's 698px column — the old assertion pinned
 * `contentMaxWidth === 1100`, i.e. a 1100px template printed into a 698px
 * column, which is exactly what made Chromium scale every page to 0.902.
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
    // What the document asked for is still detected and reported…
    assert.equal(result.contentWidthRequested, 1100);
    // …but the layout is capped at the sheet's text column, so nothing scales.
    assert.equal(result.geometry.columnW, 698);
    assert.equal(result.contentMaxWidth, 698);
    assert.equal(result.detection.sections.length, 2);
    for (const p of result.pages) {
      assert.equal(p.widthScale, 1, `page ${p.index} must not be width-scaled`);
    }
  } finally {
    for (const f of [result.master, result.email].filter(Boolean)) {
      await fs.promises.rm(f, { force: true });
    }
  }
});
