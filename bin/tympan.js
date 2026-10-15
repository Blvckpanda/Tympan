#!/usr/bin/env node
/**
 * tympan — HTML→PDF converter for AI-generated documents.
 * One semantic section per page, runtime print-CSS defeated, self-verifying.
 *
 * Thin wrapper only: flags are parsed in src/argv.js, patterns expand in
 * src/glob.js, batching and warm-browser reuse live in src/pipeline.js, and
 * `tympan test` is src/golden.js. Nothing here does pipeline work.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convert, convertMany, resolveOutputs, buildBatchJsonReport } from '../src/index.js';
import { parseArgv } from '../src/argv.js';
import { expandInputs, isUrlInput } from '../src/glob.js';

const USAGE = `Usage: tympan <input...> [options]
       tympan doctor [--json]
       tympan test <input...> [--update] [--golden <dir>] [--json]

Inputs are file paths, http(s) URLs, quoted glob patterns ("docs/*.html",
"docs/**/*.html"), or "-" to read the document from stdin. Several inputs
convert through ONE warm browser, each to <input>.pdf unless -o names a
directory. A pattern matching nothing is an error, never a silent skip.

Options:
  -o, --out <path>     Output path. A directory when there are several inputs
                       or the path ends in a separator (created if missing);
                       "-" writes the PDF to stdout (single input, no --json)
  --email              Also emit an image-downscaled -email.pdf variant
  --selector <css>     Explicit CSS selector for sections
  --format <fmt>       Page format: a4 (default) or letter
  --orientation <o>    Page orientation: portrait (default) or landscape
  --margin <spec>      Margins in inches: N or T,R,B,L (default 0.4,0.5,0.4,0.5)
  --background <css>   Page background color (default: the source's own)
  --teaser <n>         Only convert the first N sections
  --outline            Add PDF bookmarks (one per section)
  --title <t>          PDF metadata title (default: source <title>)
  --author <a>         PDF metadata author
  --subject <s>        PDF metadata subject
  --creator <c>        PDF metadata creator (application)
  --wait-for <css>     Wait for this selector before printing (charts, JS-mounted sections)
  --wait-timeout <ms>  Timeout for --wait-for (default 10000)
  --json               Machine-readable report on stdout (progress stays on stderr)
  --offline            Block every network request (fonts, images, CDNs)
  --allow-net <host>   Permit requests to this host (repeatable; wins over the blocklist)
  --probe <text>       Text that must appear on the LAST page (verification)
  --no-verify          Skip the verification pass
  --quiet              Suppress per-section progress lines
  -h, --help           Show this help

tympan test (pixel-golden regression — did the pages still look the same?):
  --golden <dir>       Baseline directory (default .tympan/golden)
  --update             Record/refresh baselines instead of comparing
  --tolerance <frac>   Share of differing cells allowed (default 0.02)
  -o, --out <dir>      Keep the generated PDFs in this directory for review
  --json               Machine-readable report on stdout`;

const SPEC = {
  valued: [
    '-o',
    '--out',
    '--selector',
    '--format',
    '--orientation',
    '--margin',
    '--background',
    '--teaser',
    '--title',
    '--author',
    '--subject',
    '--creator',
    '--probe',
    '--wait-for',
    '--wait-timeout',
    '--golden',
    '--tolerance',
  ],
  repeatable: ['--allow-net'],
  boolean: ['--email', '--outline', '--json', '--offline', '--no-verify', '--quiet', '--update', '-h', '--help'],
};

/** Bad invocation (exit 2), with the usage text. */
function usageError(msg) {
  console.error(`tympan: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

/** Conversion or verification failure (exit 1) — the command was well-formed. */
function fail(msg) {
  console.error(`tympan: ${msg}`);
  process.exit(1);
}

const args = parseArgv(process.argv.slice(2), SPEC);
if (args.has('-h') || args.has('--help')) {
  console.log(USAGE);
  process.exit(0);
}
if (args.errors.length) usageError(args.errors.join('\n  '));

/** Scratch files/dirs this run created; removed however the process ends. */
const scratch = [];
process.on('exit', () => {
  for (const f of scratch) {
    try {
      fs.rmSync(f, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function parseMargin(spec) {
  const parts = String(spec).split(',').map((s) => parseFloat(s.trim()));
  if (parts.length === 1 && Number.isFinite(parts[0])) {
    const all = parts[0];
    return { top: all, right: all, bottom: all, left: all };
  }
  if (parts.length === 4 && parts.every(Number.isFinite)) {
    const [top, right, bottom, left] = parts;
    return { top, right, bottom, left };
  }
  return null;
}

/** Assemble convert() options from the parsed flags (validating early). */
function convertOptions() {
  const opts = {
    email: args.has('--email'),
    selector: args.value('--selector'),
    background: args.value('--background'),
    offline: args.has('--offline'),
    allowNet: args.list('--allow-net').length ? args.list('--allow-net') : undefined,
    subject: args.value('--subject'),
    creator: args.value('--creator'),
    title: args.value('--title'),
    author: args.value('--author'),
    probe: args.value('--probe'),
    waitFor: args.value('--wait-for'),
    outline: args.has('--outline'),
    verify: !args.has('--no-verify'),
  };
  if (args.has('--format')) {
    const format = args.value('--format').toLowerCase();
    if (format !== 'a4' && format !== 'letter') usageError(`--format must be a4 or letter, got: ${format}`);
    opts.format = format;
  }
  if (args.has('--orientation')) {
    const orientation = args.value('--orientation').toLowerCase();
    if (orientation !== 'landscape' && orientation !== 'portrait') {
      usageError(`--orientation must be landscape or portrait, got: ${orientation}`);
    }
    opts.orientation = orientation;
  }
  if (args.has('--margin')) {
    opts.margins = parseMargin(args.value('--margin'));
    if (!opts.margins) usageError(`--margin expects N or T,R,B,L in inches, got: ${args.value('--margin')}`);
  }
  if (args.has('--teaser')) {
    const n = Number(args.value('--teaser'));
    if (!Number.isInteger(n) || n < 1) usageError(`--teaser expects a positive integer, got: ${args.value('--teaser')}`);
    opts.teaser = n;
  }
  if (args.has('--wait-timeout')) {
    const n = Number(args.value('--wait-timeout'));
    if (!Number.isInteger(n) || n < 0) {
      usageError(`--wait-timeout expects a non-negative integer (ms), got: ${args.value('--wait-timeout')}`);
    }
    opts.waitTimeout = n;
  }
  if (!args.has('--quiet') && !args.has('--json')) {
    opts.onProgress = (event, data) => {
      if (event === 'batch-input') console.error(`tympan: [${data.index}/${data.total}] ${data.input}`);
      else if (event === 'detected') console.error(`tympan: ${data.sections.length} section(s) via ${data.strategy}`);
      else if (event === 'section') console.error(`tympan: section ${data.index}/${data.total} (${data.id})`);
      else if (event === 'pass-done') console.error(`tympan: merged ${data.sections} page(s)`);
    };
  }
  return opts;
}

/**
 * Write to stdout and wait for the flush. `process.exit()` discards a piped
 * write that has not drained yet, which would truncate a large --json report
 * (or a PDF) mid-stream.
 */
async function writeStdout(text) {
  await new Promise((resolve) => process.stdout.write(text, resolve));
}

/** Read the whole of stdin (a piped document). */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Turn positional arguments into a validated input list.
 *
 * `-` becomes a scratch file in the CURRENT directory (not the temp dir) so
 * the piped document's relative references — images, stylesheets, fonts —
 * resolve the way they would for a file in the shell's directory.
 * @returns {Promise<{inputs: string[], stdinPath: string|null}>}
 */
async function resolveInputs(raw) {
  if (raw.length === 0) usageError('no input given');
  let stdinPath = null;
  const positionals = [];
  for (const arg of raw) {
    if (arg === '-') {
      if (stdinPath) usageError("stdin ('-') was given more than once");
      stdinPath = path.join(process.cwd(), `.tympan-stdin-${process.pid}.html`);
      fs.writeFileSync(stdinPath, await readStdin());
      scratch.push(stdinPath);
      positionals.push(stdinPath);
    } else {
      positionals.push(arg);
    }
  }
  const { inputs, unmatched } = expandInputs(positionals, { cwd: process.cwd() });
  if (unmatched.length) usageError(`no files match: ${unmatched.join(', ')}`);
  for (const input of inputs) {
    if (/^https?:\/\//i.test(input)) continue; // fetched by the pipeline
    if (isUrlInput(input)) {
      // A URL-shaped argument must never be looked up on disk, and `file://`
      // is not a supported scheme — say so instead of reporting a missing file.
      usageError(`unsupported URL scheme: ${input} (http and https are supported; pass a path for local files)`);
    }
    if (!fs.existsSync(input)) usageError(`input not found: ${input}`);
    if (!fs.statSync(input).isFile()) usageError(`input is not a file: ${input}`);
  }
  return { inputs, stdinPath };
}

/**
 * Where each input's PDF goes, given the -o value and the input count.
 *
 * `-o` is a directory when the path ends in a separator (created if needed —
 * that is what `-o dist/` means and it must work on a clean checkout) or when
 * it already is one; otherwise it is a file, which several inputs cannot share.
 */
function outputPlan({ inputs, stdinPath }) {
  const out = args.value('--out') ?? args.value('-o');
  const given = out !== undefined && out !== '-';
  const resolved = given ? path.resolve(out) : null;
  const isDir = given && (fs.existsSync(resolved) ? fs.statSync(resolved).isDirectory() : /[\\/]$/.test(out));
  // The default is explicit (rather than left to convert()) so stdin lands on
  // `stdin.pdf` instead of on a name borrowed from the scratch file the user
  // never typed.
  const defaultPdf = (input) =>
    input === stdinPath ? path.resolve(process.cwd(), 'stdin.pdf') : resolveOutputs(input, {}).master;

  if (out === '-') {
    if (inputs.length > 1) usageError("'-o -' writes one document to stdout — give exactly one input");
    if (args.has('--json')) usageError("--json and '-o -' both write to stdout");
    if (args.has('--email')) usageError("'-o -' has no file name to hang -email.pdf off of");
    return { toStdout: true, defaultPdf };
  }
  if (isDir) {
    fs.mkdirSync(resolved, { recursive: true });
    return { outDir: resolved, defaultPdf };
  }
  // No -o with several inputs is fine: each PDF lands beside its own source.
  if (given && inputs.length > 1) {
    usageError(
      `with ${inputs.length} inputs, -o must be a directory — an existing one, or a new one ending in a separator (got ${out})`
    );
  }
  return { out: given ? resolved : undefined, defaultPdf };
}

/** The output path for one input, whichever shape the plan took. */
function outFor(plan, input) {
  if (plan.outDir) return path.join(plan.outDir, path.basename(plan.defaultPdf(input)));
  return plan.out ?? plan.defaultPdf(input);
}

const positionals = args.positionals;

// ---------------------------------------------------------------- doctor
if (positionals[0] === 'doctor') {
  const { runDoctor, formatDoctorReport } = await import('../src/doctor.js');
  const rep = runDoctor();
  if (args.has('--json')) await writeStdout(JSON.stringify(rep, null, 2) + '\n');
  else console.error(formatDoctorReport(rep));
  process.exit(rep.summary.ok ? 0 : 1);
}

// ------------------------------------------------------- test (goldens)
if (positionals[0] === 'test') {
  const { goldenTest, formatGoldenReport } = await import('../src/golden.js');
  const resolved = await resolveInputs(positionals.slice(1));
  const opts = convertOptions();
  const keepDir = args.value('--out') ?? args.value('-o');
  if (keepDir === '-') usageError("tympan test does not write to stdout");
  let tolerance;
  if (args.has('--tolerance')) {
    tolerance = Number(args.value('--tolerance'));
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1) {
      usageError(`--tolerance expects a fraction between 0 and 1, got: ${args.value('--tolerance')}`);
    }
  }
  let report;
  try {
    report = await goldenTest(resolved.inputs, {
      ...opts,
      goldenDir: args.value('--golden') || '.tympan/golden',
      update: args.has('--update'),
      tolerance,
      keepDir: keepDir ? path.resolve(keepDir) : undefined,
    });
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
  // Report the stdin marker, not the scratch file the user never named.
  if (resolved.stdinPath) {
    for (const entry of report.entries) if (entry.input === resolved.stdinPath) entry.input = '-';
  }
  if (keepDir) console.error(`tympan test: kept the generated PDFs in ${path.resolve(keepDir)}`);
  if (args.has('--json')) await writeStdout(JSON.stringify(report, null, 2) + '\n');
  else console.error(formatGoldenReport(report));
  process.exit(report.ok ? 0 : 1);
}

// ------------------------------------------------------------- convert
const resolved = await resolveInputs(positionals);
const opts = convertOptions();
const plan = outputPlan(resolved);
const started = Date.now();

if (plan.toStdout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-stdout-'));
  scratch.push(dir);
  const result = await convert(resolved.inputs[0], { ...opts, out: path.join(dir, 'out.pdf'), email: false });
  if (result.verification && result.verification.ok === false) fail('verification failed');
  const bytes = fs.readFileSync(result.master);
  await new Promise((resolve) => process.stdout.write(bytes, resolve));
  process.exit(0);
}

if (resolved.inputs.length === 1) {
  const result = await convert(resolved.inputs[0], { ...opts, out: outFor(plan, resolved.inputs[0]) });
  const label = resolved.stdinPath ? '-' : resolved.inputs[0];
  let ok = true;
  for (const o of result.verification?.outputs || []) {
    if (o.probeOk === false || !o.pagesOk) ok = false;
    if (!args.has('--json')) {
      console.error(
        `${o.file}: ${o.pages}/${o.expected} pages` +
          (o.probeOk === false ? ' PROBE FAILED' : '') +
          (o.pagesOk ? '' : ' PAGE COUNT MISMATCH')
      );
    }
  }
  if (args.has('--json')) {
    const { buildJsonReport } = await import('../src/report.js');
    await writeStdout(JSON.stringify(buildJsonReport(result, { input: label, totalMs: Date.now() - started }), null, 2) + '\n');
  } else if (ok) {
    console.error(`tympan: wrote ${result.master}${result.email ? ` + ${result.email}` : ''}`);
  }
  if (!ok) fail('verification failed');
  process.exit(0);
}

const batch = await convertMany(resolved.inputs, {
  ...opts,
  perInput: (input) => ({ out: outFor(plan, input) }),
});
const report = buildBatchJsonReport(batch, { totalMs: Date.now() - started });
// Report the stdin marker, not the scratch file the user never named.
if (resolved.stdinPath) {
  for (const r of report.results) if (r.input === resolved.stdinPath) r.input = '-';
}

if (args.has('--json')) {
  await writeStdout(JSON.stringify(report, null, 2) + '\n');
} else {
  for (const b of batch.entries) {
    const display = b.input === resolved.stdinPath ? '-' : b.input;
    if (!b.ok) {
      console.error(`[FAIL] ${display}: ${b.error || 'conversion failed'}`);
      continue;
    }
    const pages = (b.result.verification?.outputs || []).map((o) => `${o.pages}/${o.expected} pages`).join(', ');
    console.error(`[ok] ${display} → ${b.result.master} (${pages})${b.result.email ? ` + ${b.result.email}` : ''}`);
  }
  console.error(`tympan: wrote ${report.count - report.failed} of ${report.count} document(s)`);
}
if (!report.ok) fail(`${report.failed} of ${report.count} input(s) failed`);
