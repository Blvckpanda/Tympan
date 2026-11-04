/**
 * tagged.test.mjs — `--flow --tagged`: the standards tail, end to end.
 *
 * What is proven here is what tympan OWNS: the tail (ViewerPreferences
 * /DisplayDocTitle, /Lang from the page's html lang, the pipeline-owned XMP
 * packet with the PDF/UA-1 identifier and fixed dates) and the flag's
 * honestly-scoped contracts — flow-only (deck mode refuses with a pointer to
 * --flow), absent (and inert) on untagged runs, and byte-identical across two
 * same-input runs. The structure tag tree itself is the engine's, written
 * because the single flow print is what lets it survive whole; its quality is
 * the engine's at its pin, which inspectTagged reports but does not judge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/pipeline.js';
import { findChromium } from '../src/browser.js';
import { inspectTagged, PDF_UA_VERSION } from '../src/tagged.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-tagged-'));
const fixture = (name) => path.join(FIXTURES, name);
const out = (name) => path.join(OUT, name);
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const BIN = fileURLToPath(new URL('../bin/tympan.js', import.meta.url));

test('tagged flow output carries the tail: viewer prefs, /Lang, UA id, fixed XMP', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const r = await convert(fixture('tagged.html'), {
    out: out('tagged.pdf'),
    flow: true,
    tagged: true,
    title: 'Tagged output',
    author: 'Tympan test',
    subject: 'standards tail',
  });
  assert.equal(r.layout, 'flow');
  assert.deepEqual(r.tagged, { applied: true, lang: 'en-US' });

  const facts = inspectTagged(fs.readFileSync(out('tagged.pdf')));
  assert.equal(facts.structTreeRoot, true, 'the engine wrote a structure tree on the single print');
  assert.equal(facts.markInfo, true);
  assert.equal(facts.displayDocTitle, true, 'the tail set ViewerPreferences /DisplayDocTitle');
  assert.equal(facts.lang, 'en-US', '/Lang came from the page html lang');
  assert.equal(facts.uaId, PDF_UA_VERSION, 'the XMP carries the PDF/UA identifier');
  assert.match(String(facts.xmpProducer), /^tympan \d+\.\d+\.\d+$/);
});

test('two same-input tagged runs are byte-identical (the tail owns the dates)', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  await convert(fixture('tagged.html'), { out: out('t1.pdf'), flow: true, tagged: true });
  await convert(fixture('tagged.html'), { out: out('t2.pdf'), flow: true, tagged: true });
  assert.equal(sha(out('t1.pdf')), sha(out('t2.pdf')), 'tagged output must be no less deterministic than plain flow');
});

test('untagged flow output stays untagged — no tail, no tree, no UA id', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  const r = await convert(fixture('tagged.html'), { out: out('plain.pdf'), flow: true });
  assert.equal(r.tagged, null);
  const facts = inspectTagged(fs.readFileSync(out('plain.pdf')));
  assert.equal(facts.structTreeRoot, false);
  assert.equal(facts.uaId, null);
  // At this engine pin the untagged print writes its own /ViewerPreferences
  // with DisplayDocTitle — an engine behavior, not the tail's: not asserted
  // here either way, so the pin can change it without this test lying.
  assert.equal(facts.tagged, false);
});

test('deck mode refuses --tagged with a --flow pointer, not silently untagged', async (t) => {
  if (!findChromium()) return t.skip('Chromium not available');
  await assert.rejects(
    convert(fixture('tagged.html'), { out: out('deck.pdf'), tagged: true }),
    /--tagged applies to --flow only.*structure tree/gs
  );
});

test('the CLI refuses --tagged without --flow before any browser is touched', () => {
  const res = spawnSync(process.execPath, [BIN, fixture('tagged.html'), '--tagged'], { encoding: 'utf8' });
  assert.equal(res.status, 2, `usage error exits 2 (got ${res.status})`);
  assert.match(res.stderr, /--tagged applies to --flow only/);
  assert.match(res.stderr, /--layout flow/);
});
