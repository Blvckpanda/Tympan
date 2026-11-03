#!/usr/bin/env node
/**
 * corpus.mjs — measure tympan over the whole corpus, and publish the numbers.
 *
 *   node scripts/corpus.mjs                        # run, print, write docs/
 *   node scripts/corpus.mjs --limit 8              # a quick run while iterating
 *   node scripts/corpus.mjs --compare docs/benchmarks.json   # drift since a release
 *
 * What it measures per document: page count, mean and minimum page fill, output
 * bytes, wall-clock render time, and the lint findings — so a change to the
 * pagination can be judged by the numbers instead of by taste. Every document
 * converts through ONE warm browser, exactly as a batch run does.
 *
 * What it deliberately does not do: rasterize. Fill comes from the DOM
 * measurement the converter already takes (a painted background makes any
 * pixel-coverage number read as 100% full), so the run stays fast and the
 * numbers cannot be flattered by a full-bleed design.
 *
 * The corpus is generated (scripts/corpus/generate.mjs) and its hash is
 * recorded with the results: a number without its corpus is not a measurement.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { convert, resolveGeometry, resolveOutputs } from '../src/index.js';
import { launchOptions } from '../src/browser.js';
import { lintDocument, summarizeLint } from '../src/lint.js';
import { writeCorpus } from './corpus/generate.mjs';
import { enginePin } from '../src/doctor.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = (await import('node:module')).createRequire(import.meta.url);
const { version } = require('../package.json');

function parseArgs(argv) {
  const out = { limit: null, json: 'docs/benchmarks.json', markdown: 'docs/BENCHMARKS.md', out: null, quiet: false, compare: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--markdown') out.markdown = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--compare') out.compare = argv[++i];
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--no-write') {
      out.json = null;
      out.markdown = null;
    } else if (a === '-h' || a === '--help') {
      console.log('usage: node scripts/corpus.mjs [--limit n] [--json file] [--markdown file] [--out dir] [--compare file] [--quiet] [--no-write]');
      process.exit(0);
    }
  }
  return out;
}

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
const ms = (n) => `${Math.round(n)}ms`;
const kb = (n) => `${(n / 1024).toFixed(0)}KB`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpusDir = path.join(ROOT, 'test', 'corpus');
  const { files, hash, count } = writeCorpus(corpusDir);
  const selected = args.limit ? files.slice(0, args.limit) : files;
  const pdfDir = args.out || fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-corpus-'));
  fs.mkdirSync(pdfDir, { recursive: true });

  const geo = resolveGeometry({});
  const started = Date.now();
  // One warm browser for the whole run, and one timed convert() per document:
  // the batch API is exercised elsewhere, and per-document time is a number
  // this report has to have.
  const browser = await chromium.launch(launchOptions({}));
  const entries = [];
  try {
    for (let i = 0; i < selected.length; i++) {
      const input = selected[i];
      const t0 = Date.now();
      try {
        const result = await convert(input, {
          out: path.join(pdfDir, path.basename(resolveOutputs(input, {}).master)),
          browser,
          verify: false,
        });
        entries.push({ input, ok: true, result, ms: Date.now() - t0 });
        if (!args.quiet) process.stderr.write(`  [${i + 1}/${selected.length}] ${path.basename(input)} ${Date.now() - t0}ms\n`);
      } catch (e) {
        entries.push({ input, ok: false, error: (e && e.message) || String(e), ms: Date.now() - t0 });
      }
    }
  } finally {
    await browser.close();
  }

  const results = entries.map((entry) => {
    const input = entry.input;
    const id = path.basename(input, '.html');
    if (!entry.ok || !entry.result) {
      return { id, ok: false, error: entry.error || 'conversion failed', ms: entry.ms };
    }
    const r = entry.result;
    const lint = lintDocument({
      input: id,
      pages: r.pages,
      quality: r.quality,
      geometry: geo,
      layoutWidthPx: r.contentMaxWidth,
      audit: r.audit,
    });
    const bytes = fs.statSync(r.master).size;
    return {
      id,
      ok: true,
      pages: r.quality.pages,
      bytes,
      ms: entry.ms,
      meanFill: r.quality.meanFill,
      minFill: r.quality.minFill,
      underfilled: r.quality.underfilledPages.length,
      stranded: r.quality.strandedHeadings.length,
      shrunk: r.quality.shrunkPages.length,
      overflow: r.quality.overflowPages.length,
      lint: summarizeLint([lint]),
      topRule: lint.findings.length ? lint.findings[0].rule : null,
    };
  });

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const sum = (list, f) => list.reduce((n, r) => n + (r[f] || 0), 0);
  const times = ok.map((r) => r.ms).filter((n) => Number.isFinite(n) && n > 0);
  const totals = {
    documents: results.length,
    failed: failed.length,
    pages: sum(ok, 'pages'),
    bytes: sum(ok, 'bytes'),
    meanFill: round(ok.length ? ok.reduce((n, r) => n + r.meanFill, 0) / ok.length : 0),
    underfilledPages: sum(ok, 'underfilled'),
    strandedHeadings: sum(ok, 'stranded'),
    shrunkPages: sum(ok, 'shrunk'),
    overflowPages: sum(ok, 'overflow'),
    lintErrors: ok.reduce((n, r) => n + r.lint.errors, 0),
    lintWarnings: ok.reduce((n, r) => n + r.lint.warnings, 0),
    totalMs: Date.now() - started,
  };

  const meta = {
    tympan: version,
    engine: enginePin().pinned,
    installedEngine: enginePin().installed,
    node: process.version,
    platform: `${process.platform} ${os.arch()}`,
    corpusHash: hash,
    corpusDocuments: count,
    measuredDocuments: selected.length,
    date: new Date().toISOString().slice(0, 10),
    layout: 'section',
    geometry: { format: 'a4', orientation: 'portrait', margins: geo.margins },
  };
  const report = { meta, totals, results };

  const groups = {};
  for (const r of ok) {
    const archetype = r.id.replace(/-(short|medium|long|extreme)$/, '');
    groups[archetype] ??= { documents: 0, pages: 0, bytes: 0, fillSum: 0, minFill: 1, shrunk: 0, stranded: 0 };
    const g = groups[archetype];
    g.documents++;
    g.pages += r.pages;
    g.bytes += r.bytes;
    g.fillSum += r.meanFill;
    g.minFill = Math.min(g.minFill, r.minFill);
    g.shrunk += r.shrunk;
    g.stranded += r.stranded;
  }

  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(path.resolve(args.json), JSON.stringify(report, null, 2) + '\n');
  }
  if (args.markdown) {
    // A checked-in appendix (real deliverables, hand-measured) rides along so a
    // regeneration cannot silently delete evidence the generator does not own.
    const appendixPath = path.join(ROOT, 'docs', 'benchmarks-appendix.md');
    const appendix = fs.existsSync(appendixPath) ? fs.readFileSync(appendixPath, 'utf8').trim() : null;
    const md = renderMarkdown({ meta, totals, results, groups, times, appendix });
    fs.mkdirSync(path.dirname(path.resolve(args.markdown)), { recursive: true });
    fs.writeFileSync(path.resolve(args.markdown), md);
  }

  if (!args.quiet) {
    console.log(`corpus: ${totals.documents} document(s), ${totals.pages} page(s), ${kb(totals.bytes)}, mean fill ${Math.round(totals.meanFill * 100)}%`);
    console.log(`        ${totals.underfilledPages} page(s) under target, ${totals.shrunkPages} shrunk for height, ${totals.overflowPages} wider than the column`);
    console.log(`        lint: ${totals.lintErrors} error(s), ${totals.lintWarnings} warning(s); ${failed.length} failure(s); ${ms(totals.totalMs)} total`);
    const worst = [...ok].sort((a, b) => a.meanFill - b.meanFill).slice(0, 5);
    for (const r of worst) console.log(`        worst fill: ${r.id} ${Math.round(r.meanFill * 100)}% (${r.pages} pages, ${kb(r.bytes)})`);
    if (args.json) console.log(`        wrote ${path.relative(ROOT, path.resolve(args.json))}`);
    if (args.markdown) console.log(`        wrote ${path.relative(ROOT, path.resolve(args.markdown))}`);
  }

  if (args.compare) {
    const before = JSON.parse(fs.readFileSync(args.compare, 'utf8'));
    console.log(`\nvs ${path.basename(args.compare)} (${before.meta.tympan}, ${before.meta.date}, corpus ${before.meta.corpusHash})`);
    const d = (a, b, label, fmt = (v) => String(v)) => {
      const delta = b - a;
      const sign = delta > 0 ? '+' : '';
      console.log(`  ${label.padEnd(22)} ${fmt(a)} -> ${fmt(b)}  (${sign}${fmt(delta)})`);
    };
    d(before.totals.pages, totals.pages, 'pages');
    d(before.totals.bytes, totals.bytes, 'bytes', (v) => kb(v));
    d(before.totals.meanFill, totals.meanFill, 'mean fill', (v) => `${Math.round(v * 100)}%`);
    d(before.totals.underfilledPages, totals.underfilledPages, 'pages under target');
    d(before.totals.lintWarnings, totals.lintWarnings, 'lint warnings');
  }

  if (!args.out) fs.rmSync(pdfDir, { recursive: true, force: true });
  if (failed.length && !args.limit) process.exitCode = 1;
}

/**
 * The published report. Every number here is reproducible with one command,
 * which is the only reason it is worth writing down.
 */
export function renderMarkdown({ meta, totals, results, groups, times, appendix }) {
  const sortedTimes = [...times].sort((a, b) => a - b);
  const median = sortedTimes.length ? sortedTimes[Math.floor(sortedTimes.length / 2)] : 0;
  const ok = results.filter((r) => r.ok);
  const lines = [];
  lines.push('# Corpus numbers');
  lines.push('');
  lines.push('Generated by `node scripts/corpus.mjs` — do not edit by hand.');
  lines.push('');
  lines.push(`- **tympan:** ${meta.tympan} (engine pinned at ${meta.installedEngine || 'unknown'})`);
  lines.push(`- **corpus:** ${meta.corpusDocuments} documents, hash \`${meta.corpusHash}\` (generated, deterministic — ${meta.measuredDocuments} measured here)`);
  lines.push(`- **run:** ${meta.date}, ${meta.platform}, Node ${meta.node}`);
  lines.push(`- **layout:** ${meta.layout} (${meta.geometry.format} ${meta.geometry.orientation}, margins ${Object.values(meta.geometry.margins).join('/')}in) — one detected section per page`);
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---|');
  lines.push(`| documents | ${totals.documents}${totals.failed ? ` (${totals.failed} failed)` : ''} |`);
  lines.push(`| pages | ${totals.pages} |`);
  lines.push(`| output size | ${(totals.bytes / 1024 / 1024).toFixed(1)} MB (${kb(totals.bytes / Math.max(1, totals.documents))}/document) |`);
  lines.push(`| mean page fill | ${Math.round(totals.meanFill * 100)}% |`);
  lines.push(`| pages under the 70% target | ${totals.underfilledPages} (${Math.round((totals.underfilledPages / Math.max(1, totals.pages)) * 100)}%) |`);
  lines.push(`| pages shrunk for height | ${totals.shrunkPages} |`);
  lines.push(`| pages wider than the column | ${totals.overflowPages} |`);
  lines.push(`| stranded headings | ${totals.strandedHeadings} |`);
  lines.push(`| lint errors / warnings | ${totals.lintErrors} / ${totals.lintWarnings} |`);
  lines.push(`| render time (median / total) | ${ms(median)} / ${(totals.totalMs / 1000).toFixed(1)}s |`);
  lines.push('');
  lines.push('## By archetype');
  lines.push('');
  lines.push('| archetype | documents | pages | mean fill | worst fill | shrunk | stranded | size |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const [name, g] of Object.entries(groups).sort((a, b) => a[1].fillSum / a[1].documents - b[1].fillSum / b[1].documents)) {
    lines.push(
      `| ${name} | ${g.documents} | ${g.pages} | ${Math.round((g.fillSum / g.documents) * 100)}% | ${Math.round(g.minFill * 100)}% | ${g.shrunk} | ${g.stranded} | ${kb(g.bytes / g.documents)} |`
    );
  }
  lines.push('');
  lines.push('## Worst documents by fill');
  lines.push('');
  lines.push('| document | pages | mean fill | min fill | under target | size |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of [...ok].sort((a, b) => a.meanFill - b.meanFill).slice(0, 10)) {
    lines.push(`| ${r.id} | ${r.pages} | ${Math.round(r.meanFill * 100)}% | ${Math.round(r.minFill * 100)}% | ${r.underfilled} | ${kb(r.bytes)} |`);
  }
  lines.push('');
  const broken = ok.filter((r) => r.lint.errors > 0);
  lines.push('## Known bad, and why it is in the corpus');
  lines.push('');
  if (broken.length) {
    lines.push('These documents have lint ERRORS, which means tympan is losing something:');
    lines.push('');
    for (const r of broken) lines.push(`- **${r.id}** — ${r.lint.errors} error(s), first rule \`${r.topRule}\``);
    lines.push('');
    lines.push('They reference a local image beside the document. The security gate blocks every');
    lines.push('`file://` request except the document itself, so the image does not load and prints as');
    lines.push('blank space. `tympan lint` reports it as `broken-asset` instead of letting it pass');
    lines.push('silently; inlining local assets is the next fidelity item.');
  } else {
    lines.push('No lint errors in this run.');
  }
  lines.push('');
  lines.push('## What these numbers do not say');
  lines.push('');
  lines.push('- **Fill is measured in the DOM, not from pixels.** It is the honest signal for "is this');
  lines.push('  sheet half empty" (a painted background makes coverage metrics read 100%), but it is a');
  lines.push('  measurement of the layout before printing, carried through the shrink actually applied —');
  lines.push('  not a pixel-exact claim about the final sheet.');
  lines.push('- **The corpus is generated, not scraped.** It is diverse by construction and reproducible');
  lines.push('  byte for byte; it is not a sample of real customer documents, and no benchmark of 52');
  lines.push('  synthetic sheets is.');
  lines.push('- **Render time is one machine, warm browser, sequential.** It compares releases measured the');
  lines.push('  same way; it is not a throughput claim (a cold start pays Chromium launch once).');
  lines.push('- **Section layout here.** The tables above are section mode, kept comparable across');
  lines.push('  releases; flow layout exists (`--flow`), and the appendix is its measured A/B');
  lines.push('  against this mode.');
  if (appendix && String(appendix).trim()) {
    lines.push('');
    lines.push(String(appendix).trim());
  }
  return lines.join('\n') + '\n';
}

// Guarded so the markdown renderer can be imported (and unit-tested) without
// kicking off a 52-document measurement run.
if (process.argv[1] && process.argv[1].endsWith('corpus.mjs')) await main();
