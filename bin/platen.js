#!/usr/bin/env node
/**
 * platen — HTML→PDF converter for AI-generated documents.
 * One semantic section per page, runtime print-CSS defeated, self-verifying.
 * Thin wrapper over src/index.js convert() — no pipeline logic here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { convert } from '../src/index.js';

const USAGE = `Usage: platen input.html [options]

Options:
  -o, --out <path>     Master PDF output path (default: <input>.pdf)
  --email              Also emit an image-downscaled -email.pdf variant
  --selector <css>     Explicit CSS selector for sections
  --format <fmt>       Page format: a4 (default) or letter
  --orientation <o>    Page orientation: landscape (default) or portrait
  --margin <spec>      Margins in inches: N or T,R,B,L (default 0.4,0.5,0.4,0.5)
  --teaser <n>         Only convert the first N sections
  --outline            Add PDF bookmarks (one per section)
  --title <t>          PDF metadata title (default: source <title>)
  --author <a>         PDF metadata author
  --probe <text>       Text that must appear on the LAST page (verification)
  --no-verify          Skip the verification pass
  --quiet              Suppress per-section progress lines
  -h, --help           Show this help`;

const args = process.argv.slice(2);
const VALUED = new Set(['-o', '--out', '--selector', '--format', '--orientation', '--margin', '--teaser', '--title', '--author', '--probe']);

function fail(msg) {
  console.error(`platen: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

// Single pass: collect flags; remember which args are flag values.
const consumed = new Set();
const has = new Set();
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  if (a.startsWith('-')) {
    has.add(a);
    if (VALUED.has(a)) {
      const v = args[i + 1];
      if (!v || v.startsWith('-')) fail(`missing value for ${a}`);
      consumed.add(i + 1);
      i++;
    }
  }
}
const input = args.find((a, idx) => !a.startsWith('-') && !consumed.has(idx));

function get(flag) {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('-')) fail(`missing value for ${flag}`);
  return v;
}

function parseMargin(spec) {
  const parts = String(spec).split(',').map((s) => parseFloat(s.trim()));
  if (parts.length === 1 && Number.isFinite(parts[0])) {
    const all = parts[0];
    return { top: all, right: all, bottom: all, left: all };}
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    const [top, right, bottom, left] = parts;
    return { top, right, bottom, left };
  }
  return null;
}

if (!input) fail('no input file given');
if (!fs.existsSync(input)) fail(`input not found: ${input}`);
if (!fs.statSync(input).isFile()) fail(`input is not a file: ${input}`);

let teaser;
if (has.has('--teaser')) {
  const n = Number(get('--teaser'));
  if (!Number.isInteger(n) || n < 1) fail(`--teaser expects a positive integer, got: ${get('--teaser')}`);
  teaser = n;
}

let margins;
if (has.has('--margin')) {
  margins = parseMargin(get('--margin'));
  if (!margins) fail(`--margin expects N or T,R,B,L in inches, got: ${get('--margin')}`);
}

let format;
if (has.has('--format')) {
  format = get('--format').toLowerCase();
  if (format !== 'a4' && format !== 'letter') fail(`--format must be a4 or letter, got: ${format}`);
}

let orientation;
if (has.has('--orientation')) {
  orientation = get('--orientation').toLowerCase();
  if (orientation !== 'landscape' && orientation !== 'portrait') fail(`--orientation must be landscape or portrait, got: ${orientation}`);
}

let result;
try {
  result = await convert(path.resolve(input), {
    out: has.has('-o') || has.has('--out') ? path.resolve(get(has.has('--out') ? '--out' : '-o')) : undefined,
    email: has.has('--email'),
    selector: has.has('--selector') ? get('--selector') : undefined,
    format,
    orientation,
    margins,
    teaser,
    outline: has.has('--outline'),
    title: has.has('--title') ? get('--title') : undefined,
    author: has.has('--author') ? get('--author') : undefined,
    probe: has.has('--probe') ? get('--probe') : undefined,
    verify: !has.has('--no-verify'),
    onProgress: has.has('--quiet') ? undefined : (event, data) => {
      if (event === 'detected') {
        console.error(`platen: ${data.sections.length} section(s) via ${data.strategy}`);
      } else if (event === 'section') {
        console.error(`platen: section ${data.index}/${data.total} (${data.id})`);
      } else onProgressDefault(event, data);
    },
  });
} catch (e) {
  console.error(`platen failed: ${e && e.message}`);
  process.exit(1);
}

function onProgressDefault(event, data) {
  if (event === 'pass-done') console.error(`platen: merged ${data.sections} page(s)`);
}

let ok = true;
for (const o of result.verification?.outputs || []) {
  if (o.probeOk === false || !o.pagesOk) ok = false;
  console.error(`${o.file}: ${o.pages}/${o.expected} pages` + (o.probeOk === false ? ' PROBE FAILED' : '') + (o.pagesOk ? '' : ' PAGE COUNT MISMATCH'));}

if (!ok) {
  console.error('platen: verification failed');
  process.exit(1);
}

console.error(`platen: wrote ${result.master}${result.email ? ` + ${result.email}` : ''}`);
