/**
 * smoke.mjs — end-to-end library smoke test: hostile fixture → PDF → verify.
 * Run: npm run smoke   (needs Chromium: npx playwright install chromium)
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '..', 'test', 'fixtures', 'ai-deck.html');
const outDir = path.join(here, '..', 'test', 'out');
fs.mkdirSync(outDir, { recursive: true });

const result = await convert(fixture, {
  out: path.join(outDir, 'ai-deck.pdf'),
  email: true,
  probe: 'www.fixture-deck.example',
});

console.log('detection:', result.detection.strategy, result.detection.confidence, result.detection.sections.length);
console.log('verification:', JSON.stringify(result.verification, null, 2));

const failures = [];
if (result.detection.strategy !== 'page-section-class') failures.push('detection strategy');
if (result.detection.sections.length !== 3) failures.push('section count');
if (!result.verification || !result.verification.ok) failures.push('verification.ok');
for (const o of result.verification?.outputs || []) {
  if (o.pages !== 3) failures.push(`${path.basename(o.file)} pages=${o.pages}`);
  if (o.probeOk !== true) failures.push(`${path.basename(o.file)} probe`);
}

if (failures.length) {
  console.error('SMOKE FAILED:', failures.join(', '));
  process.exit(1);
}
console.log('SMOKE PASSED:', result.master, '+', result.email);
