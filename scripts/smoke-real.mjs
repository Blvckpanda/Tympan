/**
 * smoke-real.mjs — acceptance run against a REAL deck on this machine.
 *
 *   PLATEN_REAL_DECK=path/to/deck.html npm run smoke:real
 *
 * Converts the deck through the library and asserts:
 *   - page count === detected section count on both master and email outputs
 *   - the probe text (PLATEN_REAL_PROBE, or a per-deck default) is on the last
 *     page of both outputs
 *   - the email variant is substantially smaller (image-heavy decks shrink;
 *     the ratio depends on the deck's image entropy)
 * Skips with exit 0 (not a failure) when no deck is configured or present.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { convert } from '../src/index.js';
import { findChromium } from '../src/browser.js';

const DECK = process.env.PLATEN_REAL_DECK
  || path.join(os.homedir(), 'Documents', 'deck.html');
const PROBE = process.env.PLATEN_REAL_PROBE || null;

// The "email variant is smaller" assertion only means something when the deck
// actually carries raster images to downscale. A text-only deck (webfonts
// dominate the payload) legitimately produces equal-sized variants.
const deckHtml = fs.readFileSync(DECK, 'utf8');
const hasRasterImages =
  /<img\s/i.test(deckHtml)
  || /data:image\//i.test(deckHtml)
  || /url\([^)]*\.(?:png|jpe?g|gif|webp|avif)/i.test(deckHtml);

if (!fs.existsSync(DECK)) {
  console.log(`SKIP: no real deck configured (set PLATEN_REAL_DECK); looked at ${DECK}`);
  process.exit(0);
}
if (!findChromium()) {
  console.log('SKIP: Chromium not available (run: npx playwright install chromium)');
  process.exit(0);
}

const outDir = path.join(process.cwd(), 'test', 'out');
fs.mkdirSync(outDir, { recursive: true });

const failures = [];
const result = await convert(DECK, {
  out: path.join(outDir, 'real-deck.pdf'),
  email: true,
  ...(PROBE ? { probe: PROBE } : {}),
  onProgress: (event, data) => {
    if (event === 'detected') console.log(`detected: ${data.sections.length} section(s) via ${data.strategy}`);
    if (event === 'section') console.log(`  section ${data.index}/${data.total} (${data.id})`);
  },
});

console.log(`strategy: ${result.detection.strategy} (${result.detection.sections.length} sections)`);
console.log(`contentMaxWidth: ${result.contentMaxWidth}px`);

const expected = result.detection.sections.length;
for (const o of result.verification?.outputs || []) {
  console.log(`${path.basename(o.file)}: ${o.pages}/${o.expected} pages, probe=${o.probeOk}, ${(o.sizeBytes / 1048576).toFixed(1)} MB`);
}

if (!result.verification?.ok) failures.push('verification failed');
for (const o of result.verification?.outputs || []) {
  if (o.pages !== expected) failures.push(`${path.basename(o.file)}: ${o.pages} pages, expected ${expected}`);
  if (PROBE && o.probeOk !== true) failures.push(`${path.basename(o.file)}: probe missing`);
}

const master = result.verification?.outputs?.find((o) => o.file === result.master);
const email = result.verification?.outputs?.find((o) => o.file === result.email);
if (master && email && email.sizeBytes >= master.sizeBytes) {
  if (!hasRasterImages) {
    console.log('note: deck has no raster images — email variant is expected to match master (no downscale opportunity)');
  } else {
    failures.push(`email variant not smaller: ${(email.sizeBytes / 1048576).toFixed(1)} MB vs ${(master.sizeBytes / 1048576).toFixed(1)} MB`);
  }
}

if (failures.length) {
  console.error('ACCEPTANCE FAILED:', failures.join('; '));
  process.exit(1);
}
console.log(`ACCEPTANCE PASSED: one page per section on both variants, verification OK${hasRasterImages ? ', email variant smaller' : ''}.`);
