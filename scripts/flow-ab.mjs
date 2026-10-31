#!/usr/bin/env node
/**
 * flow-ab.mjs — side-by-side measurement of section mode vs `--flow`.
 *
 * Fills the A/B column of the Phase 1 acceptance for a list of documents:
 * page count, mean/min fill, output bytes, wall time, and whether anything
 * was clipped — with fill measured from the produced PDF in BOTH modes, so
 * the comparison is reviewer-checkable rather than one DOM number measured
 * against one PDF number.
 *
 * Usage: node scripts/flow-ab.mjs doc1.html doc2.html ...
 * Prints one JSON object (synthesised identity field, measured numbers).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { convert, resolveGeometry } from '../src/pipeline.js';
import { analyzeFlowPdf } from '../src/flow.js';
import { findChromium } from '../src/browser.js';

function fillStats(analysis) {
  const fills = analysis.pages.map((p) =>
    p.usableHeightPx > 0 ? p.contentHeightPx / p.usableHeightPx : 0
  );
  const min = fills.length ? Math.min(...fills) : 0;
  const mean = fills.length ? fills.reduce((a, b) => a + b, 0) / fills.length : 0;
  return {
    pages: analysis.pageCount,
    meanFill: +mean.toFixed(3),
    minFill: +min.toFixed(3),
    blanks: analysis.pages.flatMap((p) => (p.blank ? [p.index] : [])),
  };
}

async function classify(input, outPath, label, mode) {
  const t0 = performance.now();
  const r = await convert(input, { out: outPath, flow: mode === 'flow' });
  const wall = (performance.now() - t0) / 1000;
  const geo = resolveGeometry();
  const analysis = await analyzeFlowPdf(r.master, geo);
  return {
    label,
    mode,
    wallSeconds: +wall.toFixed(2),
    bytes: fs.statSync(r.master).size,
    ...fillStats(analysis),
    clippedPages: analysis.pages.flatMap((p) => (p.clipped ? [p.index] : [])),
  };
}

async function main() {
  const inputs = process.argv.slice(2);
  if (!inputs.length) {
    console.error('usage: node scripts/flow-ab.mjs doc.html ...');
    process.exit(2);
  }
  findChromium();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-flow-ab-'));
  const rows = [];
  for (const input of inputs) {
    for (const mode of ['section', 'flow']) {
      rows.push(await classify(input, path.join(outDir, `${mode}.pdf`), path.basename(input), mode));
      console.error(`measured ${path.basename(input)} [${mode}]`);
    }
  }
  console.log(JSON.stringify({ generatedAt: 'measured run, no stamped date', outDir, rows }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
