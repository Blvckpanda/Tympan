/**
 * corpus.test.mjs — the benchmark's own guard rails.
 *
 * A published number is only worth anything if it is tied to the thing that
 * produced it, so the important test here is the last one: the corpus hash in
 * the committed report must match the generator. Change the corpus without
 * re-running the measurement and this fails, by design, before a stale number
 * reaches a README.
 *
 * Everything here is hermetic — no Chromium, no conversion.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCorpus, corpusHash, writeCorpus } from '../scripts/corpus/generate.mjs';
import { renderMarkdown } from '../scripts/corpus.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('corpus: 52 documents, unique ids, offline by construction', () => {
  const docs = buildCorpus();
  assert.equal(docs.length, 52);
  assert.equal(new Set(docs.map((d) => d.id)).size, 52, 'ids are unique');

  for (const doc of docs) {
    assert.match(doc.html, /^<!DOCTYPE html>/, `${doc.id} is a document`);
    assert.ok(doc.html.includes('<main>'), `${doc.id} has a content container`);
    // The corpus must never need the network: a benchmark that depends on a
    // CDN measures the CDN.
    assert.doesNotMatch(doc.html, /https?:\/\//i, `${doc.id} references no remote URL`);
  }

  // Diversity is the point: the archetypes should not all look alike.
  const archetypes = new Set(docs.map((d) => d.id.replace(/-(short|medium|long|extreme)$/, '')));
  assert.equal(archetypes.size, 13);
  const hazards = new Set(docs.flatMap((d) => d.flags));
  for (const hazard of ['wide-table', 'print-css', 'viewport-clamp', 'rtl', 'cjk', 'dark-theme', 'fixed-position']) {
    assert.ok(hazards.has(hazard), `corpus covers ${hazard}`);
  }
});

test('corpus: generation is deterministic and its hash tracks the content', () => {
  assert.equal(corpusHash(buildCorpus()), corpusHash(buildCorpus()), 'same generator, same corpus');
  const mutated = buildCorpus();
  mutated[7].html += '\n<!-- altered -->';
  assert.notEqual(corpusHash(mutated), corpusHash(buildCorpus()), 'a changed document changes the hash');
  const relabelled = buildCorpus();
  relabelled[7].id = 'renamed';
  assert.notEqual(corpusHash(relabelled), corpusHash(buildCorpus()), 'a renamed document changes the hash');
  // Hash is over content, not over iteration order.
  const shuffled = [...buildCorpus()].reverse();
  assert.equal(corpusHash(shuffled), corpusHash(buildCorpus()));
});

test('corpus: writeCorpus lands every document plus the local image', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-corpus-test-'));
  try {
    const { files, hash, count } = writeCorpus(dir);
    assert.equal(count, 52);
    assert.equal(files.length, 52);
    assert.ok(fs.existsSync(path.join(dir, 'corpus-logo.png')), 'the file:// image case has a real file');
    for (const file of files) assert.ok(fs.statSync(file).size > 200, `${file} has content`);
    assert.equal(hash, corpusHash(buildCorpus()));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('report: the markdown carries the numbers, the caveats and the corpus identity', () => {
  const meta = {
    tympan: '9.9.9',
    installedEngine: '1.2.3',
    corpusHash: 'deadbeefdeadbeef',
    corpusDocuments: 52,
    measuredDocuments: 4,
    date: '2026-01-01',
    platform: 'linux x64',
    node: 'v20.0.0',
    layout: 'section',
    geometry: { format: 'a4', orientation: 'portrait', margins: { top: 0.4, bottom: 0.4, left: 0.5, right: 0.5 } },
  };
  const results = [
    { id: 'deck-short', ok: true, pages: 3, bytes: 90_000, meanFill: 0.14, minFill: 0.14, underfilled: 3, stranded: 0, shrunk: 0, overflow: 3, lint: { errors: 0, warnings: 3, notes: 0, ok: true }, topRule: 'page-underfilled' },
    { id: 'article-short', ok: true, pages: 1, bytes: 40_000, meanFill: 0.58, minFill: 0.58, underfilled: 1, stranded: 0, shrunk: 0, overflow: 1, lint: { errors: 1, warnings: 2, notes: 0, ok: false }, topRule: 'broken-asset' },
  ];
  const md = renderMarkdown({
    meta,
    totals: {
      documents: 2,
      failed: 0,
      pages: 4,
      bytes: 130_000,
      meanFill: 0.36,
      underfilledPages: 4,
      strandedHeadings: 0,
      shrunkPages: 0,
      overflowPages: 4,
      lintErrors: 1,
      lintWarnings: 5,
      totalMs: 4000,
    },
    results,
    groups: { deck: { documents: 1, pages: 3, bytes: 90_000, fillSum: 0.14, minFill: 0.14, shrunk: 0, stranded: 0 } },
    times: [1200, 2800],
    appendix: '## Real deliverables\n\n| document | pages |\n|---|---|',
  });
  assert.match(md, /## Real deliverables/, 'a checked-in appendix survives regeneration');
  assert.match(md, /# Corpus numbers/);
  assert.match(md, /deadbeefdeadbeef/, 'the corpus identity is in the report');
  assert.match(md, /\| mean page fill \| 36% \|/);
  assert.match(md, /\| deck \| 1 \| 3 \| 14% \|/, 'per-archetype rollup');
  assert.match(md, /deck-short/, 'worst-fill table');
  // The failure the corpus ships on purpose must be explained, not hidden.
  assert.match(md, /broken-asset/);
  assert.match(md, /local image/);
  assert.match(md, /What these numbers do not say/);
  assert.doesNotMatch(md, /NaN/, 'no missing number leaks into the published table');
});

test('report: the committed numbers match the generator that produced them', () => {
  const doc = path.join(ROOT, 'docs', 'BENCHMARKS.md');
  const json = path.join(ROOT, 'docs', 'benchmarks.json');
  assert.ok(fs.existsSync(doc), 'docs/BENCHMARKS.md is committed');
  assert.ok(fs.existsSync(json), 'docs/benchmarks.json is committed');
  const report = JSON.parse(fs.readFileSync(json, 'utf8'));
  const hash = corpusHash(buildCorpus());
  assert.equal(
    report.meta.corpusHash,
    hash,
    'the published numbers were measured on a different corpus — re-run `node scripts/corpus.mjs`'
  );
  assert.equal(report.meta.corpusDocuments, buildCorpus().length);
  assert.match(fs.readFileSync(doc, 'utf8'), new RegExp(hash), 'the markdown names the corpus it measured');
  assert.equal(report.results.length, report.meta.measuredDocuments);
  // Hand-measured evidence (real deliverables) is appended from
  // docs/benchmarks-appendix.md, so a regeneration must not drop it.
  assert.match(
    fs.readFileSync(doc, 'utf8'),
    /## Real deliverables/,
    'the appendix about real documents is still published'
  );
});
