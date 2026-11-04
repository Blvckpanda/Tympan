# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.8.0] - 2026-10-21

### Added
- **`--flow`, one print per document (W2).** Chromium paginates the whole body
  once with injected paged-media rules (headings keep with their text,
  `orphans`/`widows` 2, `break-inside: avoid` on figures/tables/pre/blockquotes);
  `scale` stays 1 because the layout flows instead of shrinking. Opt-in:
  section mode remains the default and existing output bytes do not move —
  including the input digest (flow options hash only when flow is on).
  Measured on the Kitch documents (fill read from the produced PDF in BOTH
  modes, bytes/wall included; see
  [docs/BENCHMARKS.md](docs/BENCHMARKS.md)): 03-subscription-plans prints 10
  sheets at 64% as 8 sheets at 81% (424 KB → 132 KB, 6.6s → 2.2s); pot-counter
  collapses 4 sparse sheets into 2 real ones. The deterministic tail is shared
  between the producers in `finalize.js` (fixed Producer/dates, input-hash
  `/ID`, `tympan:<hash>` keyword), so byte-identity holds in both modes.
- **`--layout auto` — the chooser from the plan.** Every section is measured
  first (the numbers `printSection` starts from); flow is picked only when
  one-section-per-page would waste more sheet area than `targetFill` allows or
  a section starts shrinking below 0.95. The result carries the pick AND the
  arithmetic (`layoutChoice`); deck keeps running where it is already right
  (pot-counter measures full sheets).
- **Local sibling images survive the request gate (W1 finding).** The gate
  blocks `file://` reads by design, which blanked `<img src="logo.png">`. Node
  reads the file and inlines it as a data URI before detection — nothing is
  unblocked, and an asset that does not exist stays broken and reported.
  Bounds: image extensions only, 8 MB cap, regular files only.
- **`--toc` — a generated Contents page with real sheet numbers.** Section
  mode settles the numbers by arithmetic (every section prints as exactly one
  sheet); flow mode maps every section to the sheet its heading lands on via
  the PDF's own text layer and converges the numbering when the TOC's own
  block shifts it (bounded at 3 passes, stability reported).
- **Real outline destinations in flow mode.** `--outline` used to be
  rejected in flow mode because nothing could map a section to a page; the
  text-layer mapping writes bookmarks that point where the reader really
  lands (monotone search, forward-falling fallback, ids ignored so they can
  never match the wrong page).
- **`--page-footer <text>` — a running footer via Chrome 131+ margin boxes.**
  Static text (Blink has no string-set), printed by the engine next to the
  `n / total` counter and extractable from the PDF; the book/contract presets
  resolve it from the document `<title>`.
- **`--fill balanced|tight|loose` (flow only).** balanced is native flow;
  tight tries a BOUNDED uniform micro-scale ladder (1, 0.98, 0.97 — the
  plan's floor) and keeps the fewest-pages winner, reported in `fillPolicy`;
  loose extends keep-together to `li, dd, dt` and accepts gaps. Unbounded
  shrink-to-fill remains rejected. `--layout`, `--toc`, `--page-footer` and
  `--preset` join the HTTP API's allowed options.
- **`--preset deck|report|book|invoice|contract`.** Documented bundles (`deck`
  = today's deck behaviour; report = flow + page numbers; book = report + TOC
  + title running footer + book margins; invoice = tightened side margins in
  the section engine; contract = flow + page numbers + title footer).
  Explicit flags win over every preset default, in the CLI and the API.
- **Fill baselines are first-class in `tympan test`.** A baseline records each
  page's fill (measured from the produced PDF, not the DOM) in
  `<goldenDir>/<input>/fills.json`; a page dropping below its floor fails
  (`FILL_TOLERANCE` 5% relative). Existing baselines adopt theirs on first
  compare instead of failing out of the box.

### Changed
- **Merge dedup, measured honestly.** Per-section prints DO duplicate
  resources; a content-hash collapse of byte-identical streams
  (`dedupeIdenticalStreams` in `finalize.js`, applied to both modes) removes
  56 objects / 6 KB on the measured deck. The full 28→5 font-program collapse
  the plan promised CANNOT be done at the merge: subsets of the same face per
  section print have distinct glyph sets, so name-level merging would corrupt
  extraction — the byte win the plan measured (2.9x) is what `--flow`'s
  single print achieves (3.2x measured).

## [0.9.0] - 2026-11-04

### Added
- **`tympan bytes` — the size instrument SPEC §4 Phase 2 hangs on.** Converts
  with the same flags (one warm browser, batches and globs included) and
  audits the PRODUCED PDF's bytes: images, embedded font programs, content
  streams (the paint list), forms/shadings, metadata, other, and structure
  (xref, dicts, trailer) — each bucket with its byte share and its largest
  object, images carrying their /Width x /Height. Pure scanner (`src/bytes.js`,
  zero-dep, per-object positional so binary stream data is never re-parsed),
  `--json` shape matches lint's. No decompression, no judging: the shares are
  what an optimization call must cite — Phase 2's exit criterion is a measured
  size reduction vs baseline, and this is the baseline instrument (first
  measured call: article-medium 80.2 KB → 82% fonts, the glyph-subset story
  `--flow` already wins 3.2x on).
- **`--minify` — the file-rewrite size pass SPEC §4 Phase 2 names.** Same
  document, fewer bytes: dictionaries pack into deterministic compressed
  object streams (32 objects / 4096-byte batches), the whole xref becomes
  one compressed `/Type /XRef` stream (PDF 1.5, `/W [1 4 2]`, contiguous
  range), unfiltered streams gain `/FlateDecode` (level 9; `/Length1`
  untouched — it describes the font program, not the stream), and everything
  else is copied verbatim with its original object number — no renumbering,
  ever. Integrity is asserted before writing (every `/N G R` must resolve,
  otherwise the pass refuses); encrypted and incrementally-updated files
  are refused loudly. Deterministic byte-for-byte. Measured with the bytes
  instrument on the prose corpus (article-medium, section mode): 82,148 →
  76,461 bytes (7%) with pdf-lib page count and pdfjs text extraction
  byte-identical on the rewritten file. `tympan bytes` buckets the new
  plumbing (ObjStm + XRef streams) as `other` so a minified report never
  reads as "more content". Result carries `minify` stats; a refusal
  degrades to the unminified file rather than failing a good conversion.
- **`--watermark` — Stamping, the semantics half of SPEC §4's Phase 2
  "watermark, stamping" item.** The pass draws centred, 45-degree, bold
  grey 15% text across EVERY page of the finished document — placement and
  font size are pure functions of page size and the font's own advance
  widths, stamped on both artifacts (master and email variant) with
  geometry that is identical everywhere and produces deterministic bytes
  (pdf-lib re-serializes with fixed metadata, `useObjectStreams: false` so
  the minify pass that runs right after works on the file form it is
  proven on). Semantics, not plumbing: a stamping failure aborts the
  conversion loudly instead of degrading silently, and a blank watermark
  is rejected before the browser launches. Result carries `stamp` (pages
  + text drawn); pdfjs confirms the text is in every page's extractable
  layer, through the e-mail variant and the stamp+minify composition.
- **`tympan lint --a11y` — the accessibility half of lint (SPEC §4's Phase 2
  item).** Opt-in: the audit costs a second body walk on the load visit, so
  it reads `auditA11y` on the conversion options and runs only when asked.
  Findings from `src/a11y.js` (unit-testable pure rules + one in-page
  collector): `a11y-html-lang` (WCAG 3.1.1), `a11y-img-alt` (1.1.1 — a
  missing attribute; `alt=""` stays correct for decorative),
  `a11y-form-label` (4.1.2), `a11y-contrast` (1.4.3 — the text color
  composited with alpha over its nearest opaque ancestor background, 4.5:1
  floor, 3:1 for large type), `a11y-heading-order` (1.3.1), plus notes for
  zero-or-several h1, no headings, generic link text ("click here" with no
  aria-label) and headerless data tables. All warnings/notes — they never
  fail a run by default; `--strict` promotes them like lint's own. The
  rules run on the SAME source audit trip and carry capped lists with real
  totals, so a 400-image document cannot flood a log.

- **`--split` — the split half of SPEC §4's Phase 2 "merge/split/compose"
  item.** The finished master is rewritten as one artifact per sheet, written
  beside it in page order (`<out>-p01.pdf`, ...) in a stable, digit-count-padded
  naming scheme. Parts are copied with pdf-lib's `copyPages` (resources ride
  along byte-identical), inherit the document's info fields, and take the
  deterministic metadata tail from `finalize.js` (fixed dates, same Producer).
  The pass runs LAST — after stamp and minify — so a part is exactly what the
  reader gets from the master, in the compact form the minify pass produced,
  and re-splitting the same master moves not a byte. Result carries `split`
  (parts + files); pdfjs confirms each part holds exactly one page — its own,
  never the next one's.

### Security
- **`tympan ui` is gated: a per-session token on every route, a loopback Host
  allowlist, and JSON-only POST bodies.** The local preview server used to
  accept anything that reached the port, so a hostile web page could
  no-preflight a `POST /convert` at it (or rebind DNS to it) and read back the
  rendered PDF of a local file. The server now mints a per-session token
  (24 random bytes; accept `options.token` in tests) and requires it on every
  route — `GET /`, `GET /events`, `GET /pdf`, `POST /convert`, `POST /watch` —
  carried in the query string because `EventSource` and the PDF `iframe`
  cannot send custom headers (timing-safe compare). A request's `Host` must
  resolve to `127.0.0.1`/`localhost`/`::1` on the actually-bound port, so a
  forged `Host` (evil.example) or a DNS-rebound name is refused (403) even
  with a valid token, and trailing-dot forms are normalized. POST bodies that
  are not `application/json` are refused with 415 before parsing — nothing a
  no-preflight POST can ship. The bin prints the tokenized URL; the page
  carries its own key in its client code. Pinned by `test/hardening.test.mjs`.
- **The release workflow cannot leak a publish credential, and its supply
  chain is pinned.** `release.yml` upgraded to: every action pinned to a full
  commit SHA (version noted in an adjacent comment, so an audit reads the
  intent), the trusted-publishing npm upgrade pinned to an exact version
  (`npm@11.21.1`, above the 11.5.1 OIDC floor) instead of an unpinned
  `@latest`, and the GitHub Release split into its own job WITHOUT
  `id-token: write` — a compromised release action can now create a release
  but cannot mint an npm publish credential. The publish job holds
  `id-token: write` and nothing else; the tarball travels to the release as
  an artifact, so pack and release cannot drift.

### Fixed
- **A screen-`min-height:100vh` cover threw `SPILL PAGES` that no shrink could
  answer.** Chromium re-resolves `vh` against the print layout viewport
  (paper ÷ scale), so every shrink step raised the very height it was trying
  to fit — the loop burned all six retries at scale 0.55 with 608px of content
  and threw (found 2026-11-02 on a Harbor-Gardens-style AI deck). The fix is
  dimensional: before any measurement or print, blocks whose stylesheets
  declare a `vh` unit on `height`/`min-height` and lay out at ≥ 95% of the
  load viewport are rewritten to the sheet's own text-area height in CSS px —
  an absolute value the print pass cannot re-inflate — so the cover fills the
  sheet it is printed on. Counts ride the judged page record (`vhClamped`) and
  the flow result; `measureSections` clamps identically so preview numbers and
  the layout-auto chooser describe the same sheets the print will make. Pinned
  by `test/spill.test.mjs`.
- **A footer nested inside the last section printed twice.** The pull-out
  merger grabbed any `<footer>` with a bare `querySelector` — including one
  inside a section — and `mergeFooter()` then appended a copy of the band into
  the same section's html, so the flow body carried the footer text twice
  (stranded sheet at ~1% fill before it). The `<footer>` selectors are now
  direct-child scoped (`main > footer`, `body > footer`): a footer inside a
  section is content, not a trailing band. Pinned by `test/flow.test.mjs`.
- **Every page was silently scaled to 0.902, and the cause was our own
  measurement.** `resolveGeometry()` laid the document out at 774px (a constant)
  while A4 minus the default side margins is a 698px column, and
  `measureBlockInPage()` took `documentElement.scrollWidth` — which can never be
  smaller than the viewport tympan itself created. So a 700px document measured
  774px and Chromium scaled every page to fit, rendering type 10% smaller than
  authored. Geometry now carries `columnW` (the printable column) and `loadW`
  (the width the source is rendered at while measuring), `contentW` is clamped
  to `columnW`, and the width is measured on the content box. New
  `--content-width <px>` (also `contentWidth` in the API and `serve` options)
  can narrow the measure; nothing can widen it past the paper. Measured on the
  Kitch deliverables: width scale 0.902 → 1.000, mean fill +12.5%, +15.3% and
  +19.0% on the three documents, page counts unchanged —
  [docs/BENCHMARKS.md](docs/BENCHMARKS.md), "Real deliverables".
- **A document's own print CSS ran at print time, while `tympan lint` said it
  was ignored.** The clean template copied the source's first `<style>` verbatim,
  so `@media print` rules applied; a fixture with a print-only
  `min-height: 2000px` failed with `SPILL PAGES` even after six shrink retries.
  `buildCleanTemplate()` now reads the source's styles through the CSSOM and
  drops `@page` rules and print-only media blocks (keeping the non-print queries
  of a mixed list), and copies every head `<style>` in document order instead of
  only the first. Pinned by `test/layout-width.test.mjs`.
- **`--json` dropped the flow facts the result carries.** `layoutChoice`,
  `fillPolicy`, `toc`, `outline` and `pageFooter` were set on the result (and
  declared in the types) but never serialized, so `--layout auto` could not
  state WHY it picked a mode — the plan's own gate — and `--fill tight`'s
  ladder was invisible to CI. All five now travel in the report (null in
  section mode or when the switch is off, so "switch off" and "field missing"
  stay distinguishable); pinned in `test/phase1.test.mjs`.
- **A flow-mode page was judged by the section-mode target.** `underfilled`
  was computed for every page record against `--target-fill` (70%), so a flow
  document reported phantom page numbers in `underfilledPages` even though flow
  pages are filled by Chromium, not by one-section-per-sheet arithmetic. Flow
  records now carry `underfilled: null` (the tri-state mirrors
  `keptTogether`'s "unjudged in this mode") and the rollup's
  `underfilledPages` stays empty; section mode keeps the boolean and every
  number it ever reported. Every caller that knows the mode passes it
  explicitly — the pipeline's flow branch and `tympan lint`'s records — while
  the inference fallback stays for callers who genuinely don't. Type:
  `underfilled: boolean | null`. Sparse flow pages are still reported, by the
  flow-specific `flow-near-empty` rule with its own 10% floor.
- **A request with a malformed Host header crashed the whole `tympan serve`
  process.** `new URL(...)` outside the parse guard threw before the handler
  ran, so one malformed request (a hostile scan or a broken client) took the
  server — and every queued job — down with it. Host and request-target
  parsing are now inside the guarded path and answer 400; the process
  survives and keeps answering. Pinned by `test/hardening.test.mjs`.
- **Two competing configurations could print the same input digest.** The
  flow-options line in `hashInput()` sat INSIDE the block comment above it,
  so `--flow`, `--page-numbers` and the fill presets never reached the
  deterministic-input hash and the PDF's `tympan:<hash>` keyword was the same
  for outputs that differed. The line lives outside the comment now (with a
  note saying it must stay there), flow options still hash only when flow is
  on so section-mode bytes do not move, and every option that can change
  output bytes is hashed. Pinned by `test/cache-key.test.mjs`.
- **A malformed %-sequence in a preview sheet name crashed the server.**
  `decodeURIComponent` on the request path was unguarded, so one bad request
  answered with an unhandled rejection instead of a status. It is now
  guarded and the malformed name answers 400 (`src/preview.js`).
- **A null `--target-fill` silently disabled lint's underfilled rule.**
  `Number(null)` is 0 and finite, so a null target slipped past the default
  as "target 0" and nothing was ever flagged underfilled. An explicit 0 still
  turns the rule off — the documented behavior for a deliberately sparse
  deck — and only an explicit one does. Pinned by `test/hardening.test.mjs`.

### Added
- **`tympan serve` — the hosted slice, as a spike with production-shaped seams.**
  An HTTP API over the same converter: per-tenant API keys (timing-safe compare,
  empty key store = no access), a bounded FIFO queue with a worker pool and a
  per-tenant ceiling, TTL retention with early `DELETE`, request size caps, and
  `/healthz` for a load balancer. Two decisions make it an API rather than an
  SSRF proxy, both pinned by tests: a caller sends `html` or `url` and **never a
  server path**, and `offline`/`allowNet` are the SERVER's policy, dropped from
  any submitted job. A job that converts but fails verification is reported
  failed. `Dockerfile` is based on the Playwright image at the exact pinned
  engine version; [docs/SERVE.md](docs/SERVE.md) states plainly what is real and
  what a paid tier still needs ([src/serve.js](src/serve.js)).
- **A corpus benchmark, with published numbers.** `scripts/corpus/generate.mjs`
  builds 52 documents from 13 archetypes (article, report, invoice, résumé,
  deck, wide-table ledger, form, quote, newsletter, RTL, CJK, dark theme,
  viewport-sized hero) deterministically; `scripts/corpus.mjs` measures every one
  and writes [docs/BENCHMARKS.md](docs/BENCHMARKS.md) plus
  [docs/benchmarks.json](docs/benchmarks.json) — page count, mean/minimum fill,
  size, render time and lint findings per document, with the engine pin, corpus
  hash and platform, and a `--compare` mode for drift between releases. The
  current run: 52 documents, 340 pages, 15.7 MB, mean page fill 41%, 97% of
  pages under the 70% target, 0 pages wider than the column, median 2.0s per
  document (38% mean fill before the layout-width fix, with the same page
  count). A test fails if the committed numbers stop matching the generator,
  and a checked-in appendix keeps the hand-measured real deliverables in the
  published file across regenerations.
- **`tympan lint` — diagnostics that name the page, not the average.** Converts
  with the same flags and rules over the measurements the pipeline already
  takes: per-page fill, stranded headings, split keep-together blocks, images
  that never loaded (`broken-asset`, an error), blocked requests with their
  reason, the source document's own print CSS (read through the CSSOM), and
  fixed-position or viewport-sized blocks. `--strict` promotes warnings to
  failures; `--target-fill` moves the line (0 disables it, for a deliberately
  sparse deck); `--json` prints findings. It never rasterizes — every finding
  comes from a DOM measurement or a computed geometry value — and a sparse page
  is a finding, not a defect, because covers and full-bleed figures are meant to
  be sparse. Library: `lintDocument`, `summarizeLint`, `lintExitCode`,
  `formatLintReport`, `failureReport` ([src/lint.js](src/lint.js)).
- **`column-narrower-than-layout`, plus the note that replaces it.** The rule
  names the defect it was written for — a layout wider than the column, so
  Chromium scales every page (measured at 0.902 on our own deliverables) — and
  now acts as an invariant check, because geometry resolution caps the layout at
  the column. The cap itself is reported once per document as
  `content-width-clamped`, with the wider-measure remedies named.
- **`tympan test --diff` — a side-by-side review image per differing page.**
  Three panels at the comparison's own grid (baseline | current | current with
  the differing cells marked), magnified with nearest-neighbour scaling so one
  visible block is one compared cell. Written to `<golden>/diff/<input>/pNNN.png`
  (library: `diff`/`diffDir`), and the report says where on the sheet the change
  is (`diffBands`: "change is 12-38% down the sheet") — which separates a
  whole-page reflow from one moved block. A review image is never a reason to
  fail: if composing one fails, the comparison result stands.
- **The source audit travels with the result.** `convert()` now returns
  `audit` (print CSS counts, fixed/viewport-sized blocks, images that failed to
  load per page, blocked requests with reasons) and `--json` serializes it, so CI
  can gate on a lost image without a second run of the pipeline.

### Added
- **`tympan preview` — see where the cut will fall, before converting.** Serves
  a local page (127.0.0.1 only, no dependencies) with one paper-sized sheet per
  detected section: the section rendered at the print column width and scaled by
  the factor the printer will apply, the usable text area drawn to scale, a line
  where the content will stop, corner tags for the fill percentage and shrink
  factor, a badge when a sheet ends on its own heading, and the lint findings in
  the sidebar. The file is polled: save it and the page re-measures. The
  measurement runs the printer's own clean template, waits and
  `measureBlockInPage` — not a parallel implementation — and a test pins the
  agreement (preview fill vs converted fill, every page). Library:
  `buildPreviewReport`, `createPreviewServer`, `previewPage`, `sheetSizePx`
  ([src/preview.js](src/preview.js)). CLI: `tympan preview <input> [--port n]`,
  with every convert flag (geometry, margins, orientation, selector, offline)
  applying so the preview matches the conversion you are about to run.
- **Shared measurement module** ([src/measure.js](src/measure.js)): the in-page
  block measurement (height, real content width, last block kind, failed images)
  moved out of `printSection`, so the printer and the preview measure with one
  function instead of two copies of the same scan.

### Changed
- **A shrink is now attributed.** `scaleApplied` said a page shrank, but not
  why, so one document-wide width mismatch read as nine per-page warnings on the
  Kitch deck. Page records gain `widthScale` and `scaledFor` (`height` | `width`
  | `none`); `quality.shrunkPages` counts height-bound shrinks only, and the new
  `quality.overflowPages` carries the width-bound ones. The CLI quality line
  follows ("2 page(s) shrunk to fit; 7 page(s) wider than the column").

### Fixed
- **`--format letter` printed into an A4-shaped box.** `resolveGeometry`
  hard-coded the inches (8.27×11.69) for every format, so a letter document was
  laid out by Chromium on an A4 page and then merged onto a 612×792pt letter
  sheet — an inconsistency that survived because the two ratios are nearly
  identical. Inches are now derived from the chosen format's points (72/inch):
  letter is 8.5×11in, A4 is unchanged (8.27×11.69in), so the default path's
  output bytes do not move. Found by the preview's sheet-size test.

## [0.7.0] - 2026-10-15

### Added
- **Batch input: several documents, one warm browser.** `tympan a.html b.html`
  (or `tympan "docs/*.html" -o dist/`) converts every input through a single
  Chromium launch instead of one launch per file. Each document reports its own
  ok/error, a failure does not abandon the rest of the batch, and the exit code
  is non-zero when any input failed. Library: `convertMany(inputs, { perInput })`;
  report: `buildBatchJsonReport` (`{ ok, count, failed, results[] }`, each entry
  the same shape as the single-document `--json`).
- **Quoted glob patterns.** `tympan "docs/**/*.html"` expands in-CLI (`*`, `?`,
  `[...]`, `**`) — Windows shells and quoted arguments pass patterns through
  unexpanded, so `tympan "docs/*.html"` used to look for a file literally named
  `*.html`. Dependency-free matcher ([src/glob.js](src/glob.js)), sorted output so
  batch order never depends on `readdir()`, duplicates collapsed, and a pattern
  that matches nothing is an **error** rather than a silent skip.
- **stdin (`-`) and stdout (`-o -`).** `cat brief.html | tympan - -o brief.pdf`
  reads the document from stdin (materialized in the working directory, so
  relative images and stylesheets resolve exactly as they would for a file in the
  shell's directory); `tympan brief.html -o - > brief.pdf` streams the PDF to
  stdout without writing anything behind the user. `--json` and `-o -` refuse to
  share stdout, and `--email` has no file name to hang `-email.pdf` off of.
- **`tympan test` — pixel-golden regression.** Converts each input, turns every
  rendered page into a 96px-wide RGB fingerprint and compares it with a recorded
  baseline in `.tympan/golden/` (a viewable PNG per page): `--update` records,
  `--tolerance` sets how much difference is still "the same page" (default 2% of
  cells), `-o <dir>` keeps the generated PDFs so a diff can be reviewed.
  Catches what text extraction cannot — a dropped background, a collapsed grid, a
  figure that stopped rendering. A shrunken document fails (`stale baseline`), and
  a geometry change is reported as such instead of being squashed to fit.
  Rasterization runs pdfjs (already a dependency) inside Chromium: no new package,
  no HTTP server, no port to clean up.
- `--flag=value`, `--` to end flag parsing, and unknown options now fail loudly
  instead of being ignored.

### Fixed
- **`--allow-net <host>` no longer swallows the input.** Its value was left
  unconsumed, so `tympan --allow-net 127.0.0.1 deck.html` tried to convert
  `127.0.0.1` and silently ignored the real file.
- **URL inputs survive the CLI's file check.** A URL was resolved as a path
  (`.../http:/host/doc.html`) and rejected as "input not found" before the
  pipeline ever saw it: the v0.6 URL input worked from the library only. A
  URL-shaped argument is now also never glob-expanded (a query string's `?`
  would have read as a wildcard).
- **stdin's default output is `stdin.pdf`**, not a name borrowed from the
  scratch file the user never typed.
- A `file://` argument now says the scheme is unsupported and to pass a path,
  instead of reporting a missing file.

### Changed
- `bin/tympan.js` is an orchestration script again: flag/value parsing moved to
  [src/argv.js](src/argv.js) and pattern expansion to [src/glob.js](src/glob.js),
  both pure and unit-tested. `--json` reports (and a `-o -` PDF) are written with
  a flushed stdout, so `process.exit()` can no longer truncate a piped write.

## [0.6.0] - 2026-09-29

### Added
- **`--wait-for <selector>`** (library: `waitFor`, `waitTimeout`): wait for a
  CSS selector the document author controls before printing — charts drawn
  by JS, lazily mounted sections. Runs after the fonts and image waits;
  timeout surfaces a clear error so CI fails loudly. Pinned by a mount test
  (content rendered 600ms after load must appear in the PDF) and a
  timeout test.
- **`--json`** (CLI): a stable machine-readable report on stdout — detection
  strategy/sections/prelude, output paths, verification per output, blocked
  request count, `background`, `contentMaxWidth`. Progress stays on stderr;
  the report is the only stdout content. Serializer is a pure function
  ([src/report.js](src/report.js)), unit-tested.
- **`tympan doctor [--json]`**: environment and engine check — Node version,
  exact playwright pin vs installed version, Chromium discovery
  (`TYMPAN_CHROMIUM`), ffmpeg (informational). Non-zero exit when a required
  check fails, so setup scripts and CI can gate on it.
- **URL input**: `convert('https://example.com/report.html')` and
  `tympan https://…` now work end to end (output name derived from the URL
  path; the URL participates in the determinism hash). Completes the spec's
  "file, URL, stdin, glob" input story one step further.
- file:// leak E2E: a converted page (top-level http **or** file) can never
  leak local file content into the PDF. Documents the layering honestly:
  Chromium pre-blocks page-initiated `file://` subresources before userland
  route handlers run; the gate's `file://` branch (unit-pinned) is
  defense-in-depth, while the gate's network blocking is proven live.

## [0.5.0] - 2026-09-29

### Changed
- **Portrait is the default orientation** (A4 portrait, 595×842pt). Web
  documents are written top-down; portrait is the sheet they mean. Landscape
  stays one flag away for slide decks: `--orientation landscape` (or the UI
  toggle). This is the visible flip of the release — re-run old commands and
  expect tall pages.
- **The output looks like your document.** Fidelity fixes driven by a real
  dark-themed creative brief that converted to a washed-out landscape PDF:
  - The source's **page background** (computed `html`/`body` color, or its
    gradient) is measured and carried into the clean template, and each final
    page is painted with the solid base color under the content — margins
    included. `--background <css>` (library: `background`) overrides.
  - **Pre-section content becomes page 1.** Hero/cover markup before the first
    detected section (and the trailing footer band on the last page) is now
    part of the output; previously the hero was silently dropped. Detection
    distinguishes content from scroll chrome (nav bars, banners) by geometry.
  - The **load viewport comes from the source's own content width** (clamped
    700–1100px) instead of a hardcoded landscape width, so `clamp()` headings
    and grid columns reflow the way the author saw them.
  - Runtime-injected **body-level `<style>` tags** now survive section
    extraction (only the first head style was carried before).
  - Print scale now fits the **width** too: sections wider than the text area
    shrink instead of being silently right-clipped.
- **Deterministic output, proven:** identical input + options produce
  **byte-identical PDFs** under the pinned engine. Fixed metadata epoch,
  input-derived trailer `/ID`, and a `tympan:<hash>` Keywords entry over the
  source bytes and output-affecting options. Verified by a twice-convert
  sha256 test on fixtures and on a real 8-page document.
- **Secure by default** (the spec's second wedge): untrusted documents cannot
  read local files (non-top-level `file://` requests are blocked) or reach
  private/link-local networks — including cloud-metadata endpoints
  (169.254.169.254, fd00:ec2::254). Every block is counted and reported
  (`blockedRequests` in the result, `blocked` progress events). Escapes are
  explicit: `--offline` blocks all network, `--allow-net <host>` permits
  named hosts (repeatable, wins over the blocklist).
- **PDF Producer is now `tympan <version>`** — pdf-lib's save-time overwrite
  is bypassed (`updateMetadata: false`), so the trailer no longer credits the
  wrong tool. Author/Subject/Creator metadata wired through CLI
  (`--author/--subject/--creator`) and library.
- `git rm`'d the committed 190 KB base64 image fixture: photo-like fixtures
  are generated at test time into gitignored `test/out/`
  ([scripts/gen-image-fixture.mjs](scripts/gen-image-fixture.mjs)) — the
  committed pattern also could not discriminate the email-variant shrink.

### Fixed
- **The email pass no longer clobbers the master.** The per-pass workfile was
  renamed to a constant in the determinism pass, so with `email: true` the
  second pass overwrote the first and both outputs were the email variant
  (the email-size "tie" in tests was this bug wearing a trenchcoat).
- Real-deck acceptance page-count expectation now accounts for the prelude
  page.

### Added
- Demo GIF of the live UI flow ([assets/demo.gif](assets/demo.gif)); social
  card and UI shot re-shot under the v0.5 fidelity story.
- CLI: `--background`, `--offline`, `--allow-net`, `--subject`, `--creator`;
  UI: orientation + background controls. Library docs updated in
  [types/index.d.ts](types/index.d.ts).
- Fidelity/determinism/security regression suite
  ([test/fidelity.test.mjs](test/fidelity.test.mjs)) on a dark-portrait
  structural fixture ([test/fixtures/brief-dark.html](test/fixtures/brief-dark.html)).

### Removed
- The old landscape default (see above) — the one intentional breaking
  change; everything else is additive.

## [0.4.2] - 2026-09-29

### Changed
- **Publishing is now fully token-free.** The repository carries no npm
  secret at all: the release workflow authenticates via npm trusted
  publishing (OIDC from GitHub Actions; the package's Trusted Publisher
  entry names this repo and `release.yml`, and the workflow carries
  `id-token: write`). Provenance is signed automatically. The temporary
  `NPM_TOKEN` fallback from 0.4.1 is gone — from the workflow env and
  from the repository secrets — so if authentication ever breaks, the
  publish fails loudly instead of silently skipping.

## [0.4.1] - 2026-09-29

### Changed
- **The package is now unscoped: `npm install tympan`.** The name `tympan`
  was always the spec's first choice (SPEC §9) and free on the registry;
  the `@blvckpanda/` scope was purely defensive after npm's typosquat
  filter rejected the earlier working name at publish time. Scoped names
  skip that filter, so the scope existed to get *a* name out — with the
  final name verified free, the package ships as plain **`tympan`**. The
  scoped package `@blvckpanda/tympan@0.4.0` remains published as a stable
  alias; it will be deprecated once the unscoped line is proven.
- The release workflow's publish step is no longer skipped when
  `NPM_TOKEN` is absent (the `if:` guard removed): under npm trusted
  publishing the workflow authenticates via OIDC and needs no npm token
  secret at all. `NPM_TOKEN` remains set only as a fallback while the
  trusted publisher is re-pointed at the unscoped package; it is deleted
  in 0.4.2.

## [0.4.0] - 2026-09-29

### Changed
- **Renamed the project to tympan** — the padded sheet on a printing press
  that presses the paper against the type (SPEC §9). The package publishes
  as **`@blvckpanda/tympan`** (scoped names skip npm's typosquat similarity
  filter entirely — the lesson from the `aipdf` → `jspdf` rejection); the
  installed commands are `tympan` and `tympan-ui`; the repo is
  github.com/Blvckpanda/Tympan. The Chromium override environment variable
  is now `TYMPAN_CHROMIUM`; the acceptance runner's are `TYMPAN_REAL_DECK`
  / `TYMPAN_REAL_PROBE`.
- **Adopted the product spec as [SPEC.md](SPEC.md)** — verbatim, plus an
  "Adoption decisions" section recording every deviation and why:
  blocklist-over-allowlist security defaults, the exact-pinned Playwright
  engine contract, JavaScript through v1, the honest byte-determinism
  claim, and section-per-page as the default strategy. README positioning
  now leads with the spec's wedge: deterministic, secure, fast.
- The `playwright` dependency is exact-pinned (`1.63.0`, no caret): a
  floating engine is a rendering change in disguise.

### Fixed
- **Text probes no longer fail on extraction whitespace.** pdfjs joins text
  items with unstable gaps ("solo   developer"), so any multi-word `--probe`
  could miss text that is visibly on the last page. Probes are now
  case-insensitive and whitespace-flexible: every space in the probe matches
  any whitespace run in the extracted text. String probes also match
  *literally* now (metacharacters escaped) — they are text to find, not
  patterns to compile; pass an explicit RegExp for regex semantics.

### Added
- **Regression test for the shrink-to-fit spill fix.** A tall-text fixture
  with a late-applying webfont (injected after `fonts.ready` and the
  height measurement, but before the print — the exact race that produced
  sliver second pages before v0.3.3) must still convert to exactly one
  page per section: boundary-height and oversized variants, plus an
  end-to-end three-section run. Pins the closed print→count→shrink loop so
  this bug class cannot return silently.

## [0.2.0] - 2026-09-28

### Fixed
- **Hyperlinks now survive the merge.** The pipeline previously embedded each
  printed page as an XObject (pdf-lib `embedPage`), which silently dropped all
  link annotations; pages are now copied directly (`copyPages`) and rescaled,
  keeping every link clickable. Covered by an annotation-asserting test.

### Added
- `outline` option / `--outline` flag: PDF bookmarks panel with one entry per
  section (titles from each section's first heading or data/aria labels).
- Metadata options `title` / `author` / `subject` (CLI: `--title`, `--author`);
  title defaults to the source document's `<title>`.
- Per-section titles flow through detection for outline naming.

### Known limitation
- The Producer field remains pdf-lib's (its `save()` hardcodes it); other
  metadata fields persist normally.

## [0.3.3] - 2026-09-29

### Changed
- ** Renamed the project to platen** (the press plate that meets the paper).
  npm's typosquat protection rejected the unscoped `aipdf` at publish time
  (too similar to `jspdf`), so the package ships as **`@blvckpanda/platen`**;
  the installed command is `platen` (`platen-ui` for the preview UI), and the
  repo lives at github.com/Blvckpanda/Platen. The Chromium override environment
  variable is now `PLATEN_CHROMIUM`; the acceptance runner's are
  `PLATEN_REAL_DECK` / `PLATEN_REAL_PROBE`.

### Fixed
- **Shrink-to-fit now actually holds its one page.** Open-loop scaling measured
  the section once and printed at the exact boundary scale; late font swaps
  (e.g. webfonts applied after measurement) and Chromium's print rounding
  spilled moderately-tall sections onto a sliver second page. Printing is now
  verified per section and the scale shrinks 10% per retry until the section
  fits — the one-page-per-section guarantee is enforced by the output, not the
  estimate.

### Added
- First npm publication: `npm install @blvckpanda/platen` / `npx @blvckpanda/platen` now installs from
  the registry. `package.json` gains `repository`, `homepage`, and `bugs`
  pointing at the GitHub repo (required for npm provenance).
- README: Release workflow badge, npm version + license badges, and a
  Screenshots section (social card, `platen ui` in action).
- `smoke:real` accepts any deck via `PLATEN_REAL_DECK` / `PLATEN_REAL_PROBE`.

## [0.3.1] - 2026-09-28

### Changed
- The real-deck acceptance runner (`npm run smoke:real`) is fully decoupled
  from any specific project: the deck path and probe text come from
  environment variables instead of hardcoded paths.

## [0.3.0] - 2026-09-28

### Added
- `--probe <text>` CLI flag: text that must appear on the last page (hit exits
  0, miss exits 1, missing value exits 2).
- `platen ui` (`bin/platen-ui.js`, `npm run ui`): zero-dependency local preview
  server — paste HTML or watch a file, per-section progress over SSE, result in
  the browser's native PDF viewer, live reload on save.
- Image-heavy email-variant test that runs on Linux CI (deterministic
  three-image 2000x1200 fixture, regenerable via
  `scripts/gen-image-fixture.mjs`).
- Release automation: `.github/workflows/release.yml` publishes on `v*` tags
  with provenance and attaches the tarball to a GitHub Release; the publish
  step skips cleanly while the `NPM_TOKEN` secret is unset.
- Launch assets: 1280x640 social card, animated before/after GIF, SHOW_HN
  draft; README upgraded with CI badge, quickstart, and an honest Limitations
  section.
- `PUBLISHING.md` and `CONTRIBUTING.md`.

## Historical (kept verbatim) — the original launch staircase

The working list as it stood before the first public release line, never dated
as releases shipped. Every item below landed in the versions that followed
(the library API, the section-detection ladder, the clean-document pipeline,
the email variant, self-verification, release automation, the launch assets
are all in the shipped package), so this is history, not open work. The
entries are unchanged.

### Added
- `convert(input, options)` library API and `platen` CLI (in progress).
- Generic section detection: explicit selector → `section.page-section` →
  `[data-page]` / `[data-slide]` → `<section>`/`<article>` children of the main
  container → whole-document fallback, with a reported strategy + confidence.
- Clean-document cloning pipeline that defeats runtime-injected print CSS
  (`break-before/after: page`, `100vh` clamps, `@page` caps).
- Guaranteed one-section-per-page output with automatic shrink-to-fit scaling
  and centered vector merging (selectable text preserved).
- Email-optimized variant: in-DOM image downscaling (canvas JPEG) followed by
  section re-extraction, so the smaller variant actually embeds the smaller
  images.
- Self-verification: page count vs section count, zero spill pages, and
  arbitrary text probes on the last page.
