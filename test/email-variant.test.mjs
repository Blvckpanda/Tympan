/**
 * email-variant.test.mjs — proves the email pipeline on a photo-like deck
 * (three deterministic 2000x1200 PNGs generated at test time into the
 * gitignored test/out/): the email variant must be substantially smaller
 * than the master, both must stay one-page-per-section, and the downscale
 * step must report real work with no failures.
 * Needs Chromium; skips cleanly when unavailable (so unit-only CI still runs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/index.js';
import { findChromium } from '../src/browser.js';
import { writeImagesFixture } from '../scripts/gen-image-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = writeImagesFixture(path.join(here, 'out', 'ai-deck-images.html'));
const skip = findChromium() ? false : 'Chromium not available';

test('email variant shrinks an image-heavy deck with zero failures', { skip }, async () => {
  const result = await convert(fixture, {
    out: path.join(here, 'out', 'email-test.pdf'),
    email: true,
    emailMaxWidth: 900, // below Chromium's effective print resolution, so the
    // canvas JPEG genuinely sheds bytes (Chromium itself downsamples/re-encodes
    // images at print time — the master cannot be beaten at similar res).
    probe: 'Image Section',
  });
  try {
    assert.equal(result.detection.sections.length, 3);
    assert.ok(result.emailStats, 'email stats reported');
    assert.ok(result.emailStats.resized >= 3, `expected >=3 resized, got ${result.emailStats.resized}`);
    assert.equal(result.emailStats.failed, 0);

    assert.ok(result.verification.ok, 'verification passed');
    const master = result.verification.outputs.find((o) => o.file === result.master);
    const email = result.verification.outputs.find((o) => o.file === result.email);
    assert.equal(master.pages, 3);
    assert.equal(email.pages, 3);
    assert.equal(master.probeOk, true);
    assert.equal(email.probeOk, true);
    // Strict shrink: with emailMaxWidth below the master's effective print
    // resolution, the email JPEG must be clearly smaller than whatever
    // Chromium embedded for the master.
    assert.ok(
      email.sizeBytes < master.sizeBytes,
      `email ${(email.sizeBytes / 1048576).toFixed(2)}MB should be smaller than master ${(master.sizeBytes / 1048576).toFixed(2)}MB`
    );
  } finally {
    await fs.promises.rm(result.master, { force: true });
    if (result.email) await fs.promises.rm(result.email, { force: true });
    await fs.promises.rm(fixture, { force: true });
  }
});
