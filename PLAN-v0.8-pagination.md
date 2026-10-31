# Plan — pagination that fills the page (tympan v0.8)

Status: **W1-W4 built and measured (v0.8.0).** The plan was approved and
implemented in full: W2 (`--flow`, one print; `--layout auto`; local-asset
inlining; the honest merge-dedup result — see the CHANGELOG), W3 (page
numbers, running footer, generated TOC with real sheet numbers, presets,
`--fill`), W4 (fill baselines in `tympan test`, CHANGELOG, v0.8.0). Numbers
below are the plan's original history; §12 records the delivered A/B.
Scope note: SPEC §4 already charters this as Phase 3 "Smart pagination" and §8
says do not pull Phase 2+ forward — this plan re-prioritises that item to v0.8
because it is the first thing a human sees and it is currently the weakest part
of the output. Everything below is measured, not asserted.

## 1. What is wrong, measured

Per-page fill on **our own shipped deliverables** (`/tmp/fill.mjs`, ink coverage
and where the content stops, 96px-rasterised via pdfjs):

| document | pages | content ends at (per page) | mean sheet left blank |
|---|---|---|---|
| `Kitch/kitch-pdf/01-brand-base.pdf` | 11 | 17, 25, 35, 41, 19, 26, 21, 31, 95, 32, 46% | **~65%** |
| `Kitch/kitch-pdf/03-subscription-plans.pdf` | 9 | 17, 43, 33, 51, 25, 95, 59, 86, 60% | ~48% |
| `Kitch/kitch-pdf/pot-counter.pdf` | 4 | 100% every page | 0% (full-bleed by design) |

A/B on the real 8-section `03-subscription-plans.html` (`/tmp/flowprobe.mjs`),
A = tympan today, B = the same document as **one** flowing print with
paged-media rules injected:

| | pages | mean ink | mean content ends at | pure print time | file size | font programs embedded |
|---|---|---|---|---|---|---|
| A section-per-page | 9 | 14.0% | 52% | 5.7 s | 409 KB | **28** (`SegoeUI` ×18) |
| B one flowing print | **7** | **22.1%** | **82%** | **0.5 s** | **142 KB** | **5** |

So today a prose document costs ~22% more pages, ~48% wasted sheet area, ~11×
the print time and ~2.9× the bytes of the same content paginated as a document.

## 2. Root cause (where it lives in the code)

- **One detected block = one page, always** (`src/pipeline.js` `runPassFull`,
  documented as a hard rule in README "Limitations"). A 300-word markdown
  section becomes a whole sheet; the page count is the section count.
- **Shrink is the only tool.** `printSection` scales the whole block down
  (`scale *= 0.9`, up to 6 attempts) until it holds one page. Consequences:
  type size differs *between pages of the same document* (non-monotonic
  typography), and a genuinely page-plus block throws `SPILL PAGES` — a long
  chapter cannot be converted at all.
- **Per-page print jobs duplicate shared resources.** Each block is printed as
  its own document and merged with `copyPages`, so every page carries its own
  copy of the subset fonts (28 vs 5 font programs above). Fixable independently.
- **Nothing measures the result aesthetically.** Verification checks page count,
  spill and a text probe — never "is this page half empty?", so this shipped
  silently through v0.5–v0.7.

## 3. Design — measure first, then choose how to paginate

Add `layout: 'auto' | 'deck' | 'flow'` (CLI `--layout`), default `auto`.

1. **Measure** (no printing): every detected block's height vs the usable page
   area — data `printSection` already produces before it prints anything.
2. **Choose**:
   - `deck` — today's behaviour: forced break per detected block, shrink to fit.
     Right for slide decks and designed full-bleed pages (`pot-counter.pdf`
     measures 100% fill — that mode is correct there and must not regress).
   - `flow` — **one** `page.pdf()` call over the clean template holding the whole
     body, so Chromium's own fragmentation engine (LayoutNG, blocks since
     Chrome 102, print since 108) fills each sheet and breaks at legal points.
   - `auto` — pick by measurement: if one-block-per-page would waste more than a
     configured fraction of the document's sheet area, or any block needs
     scaling below ~0.95, use `flow`; otherwise `deck`. Explicit override always
     wins, and the JSON report states which mode was used and why.
3. **Make flow mode safe** (the wedge must survive):
   - Remove the source document's own `@media print` and `@page` rules **at the
     CSSOM level** (`sheet.deleteRule`, not regex) — an AI bundle's injected
     print CSS is exactly what tympan exists to defeat.
   - Inject our paged-media sheet: `break-after: avoid-page` on headings,
     `break-inside: avoid-page` on figures/tables/quotes, `orphans`/`widows`,
     `thead { display: table-header-group }` for repeated table headers.
   - Determinism is preserved by the same post-process the merge path uses:
     pdf-lib with fixed timestamps, content-derived `/ID` and the
     `tympan:<hash>` keyword. **Gate:** byte-identical output across runs.
4. **Fill policy** (the "smart cut" instinct, bounded and documented):
   `--fill balanced|tight|loose` (default `balanced`).
   - `balanced`: native flow only — a block that does not fit moves whole.
   - `tight`: allow a bounded micro-fit — shrink a block by at most ~3% and trim
     inter-block spacing to pull a near-fitting block onto the current page,
     never below a floor. Bounded, deterministic, reported.
   - `loose`: keep-together always wins; gaps are accepted.
   Unbounded shrink-to-fill is explicitly rejected: it is what produces the
   inconsistent type sizes today.
5. **Auto bookmarks in flow mode**: after printing, read each heading's page out
   of the text layer (pdfjs, already a dependency) and write the outline with
   real destinations — today's outline is one entry per page, which is only
   correct for decks. This also covers SPEC Phase 1's "auto bookmarks from
   headings" for flowing documents.

## 4. Acceptance criteria (CI-checkable, no vibes)

On the Kitch fixture set, with `layout: auto`:

- `03-subscription-plans.html`: ≤ 7 pages, mean content-end ≥ 80%, zero
  stranded headings (defined below), output ≤ 200 KB.
- `01-brand-base.html`: ≤ 8 pages, mean content-end ≥ 80%, no page below 60%
  except an intentional cover/opener page.
- `pot-counter.html`: **unchanged** — 4 pages, 100% fill (deck mode, no regression).
- Byte-identical output across two runs, in both modes.
- One page may legitimately end early when a keep-together block (a table or
  figure) does not fit; the report must name that block. P5 of the prototype
  (ends 44%) is that case and will be inspected, not "fixed" by shrinking.

Definitions used by the report and the tests: *fill* = share of the sheet that
is not blank (measured from the rendered page, which `src/golden.js` can already
rasterise); *stranded heading* = a page whose last visible line is a heading,
excluding intentional cover/opener pages; *split row* = a table row whose text
appears on two pages.

## 5. Workstreams

- **W1 — visibility (ships alone, no rendering change).** Per-page fill, largest
  blank band, applied shrink factors, stranded headings and split rows in the
  `--json` report, plus `tympan lint` to print them as diagnostics. Tests.
  This is the measurement that would have caught the current output.
  **DONE 2026-10-16** — `src/metrics.js` (fill, blank tail, stranded heading,
  keep-together, scale), `src/lint.js` (13 rules, errors vs findings), audit on
  the result, `tympan lint --strict/--target-fill/--json`, `tympan test --diff`
  review images. 103 tests. See §11.
- **W2 — flow engine.** `--layout`, the CSSOM print-CSS removal, the injected
  paged-media sheet, one-print flow path, resource de-duplication on merge
  (fixes the 28 → 5 font programs, ~2.9× size), determinism gate, docs.
- **W3 — page furniture and presets.** Page numbers and a running footer via
  `@page` margin boxes (Chrome 131+; verify in the pinned engine), generated TOC
  with page numbers, and `--preset deck|report|book|invoice|contract` — which
  also closes the "presets + config file" gap still open from SPEC Phase 1.
- **W4 — verification and release.** Fill baselines as a first-class part of
  `tympan test` (a baseline records expected fill; a page dropping below its
  floor fails), CHANGELOG/semver note (this is a rendering change), v0.8.0.

## 6. Deliberately not doing

- **Not screenshot-driven break decisions.** Measuring block heights in the DOM
  is exact, sub-pixel, and needs no rasterisation; discovering geometry from
  pixels is a lossy round trip. Pixels stay where they earn their keep: as the
  independent *verifier* (fill ratio, blank bands, golden regression).
- **No second rendering engine, no Paged.js.** It would break the
  pinned-engine determinism story that the whole product rests on. Revisit only
  for footnotes and TOC leaders, which Blink genuinely lacks.
- **No unbounded shrink-to-fill.**
- **No Phase 2 standards pulled forward** (PDF/A, tagged PDF) until pagination is
  right.

## 7. Backlog after this (gaps the competition owns)

| gap | who has it | why it matters |
|---|---|---|
| page numbers, running headers/footers | Prince, WeasyPrint, PDFreactor | free-ish with Chrome 131 margin boxes; expected in every report/book |
| footnotes, cross-references, TOC leaders | Prince, WeasyPrint, Vivliostyle | the printing features Blink does not implement (needs a polyfill layer) |
| tagged PDF / PDF-UA, PDF/A | PDFreactor, DocRaptor | accessibility and archival procurement requirements |
| size optimisation | all | **we are 2.9× fatter than needed today** (W2 fixes part of it) |
| parallel batch | SPEC Phase 1 asks; we shipped warm-but-sequential | throughput for 10k invoices |
| `lint` diagnostics | nobody does this well | our stated wedge #3 — and it is what catches this class of bug |
| `preview` with a break overlay | SPEC CLI sketch | making pagination visible while editing |
| templating + data merge (JSON/CSV) | most make you build your own | the invoicing market, SPEC Phase 3 |
| encryption, signatures (PAdES), watermark, merge/split with unified numbering | Gotenberg, PDFreactor | enterprise PDF operations |
| HTTP/daemon mode, GitHub Action | Gotenberg, hosted APIs | drop-in adoption without a local install |

## 8. Positioning note (from the competitor research)

Nobody's differentiator is "one element per page" — that is a behaviour, and for
prose it is a defect. The defensible wedge is the combination tympan already has:
**deterministic bytes + safe-by-default on untrusted HTML + self-verifying +
zero-config, all local.** Pagination quality is table stakes set by Prince,
WeasyPrint and Vivliostyle; being visibly worse at it undercuts the wedge, and
being good at it while staying deterministic, local and dependency-light is
the part nobody else does.

## 9. Decisions needed before W2

1. Does `auto` become the **default** (a rendering change for existing users), or
   does flow stay opt-in behind `--layout flow` for one release?
2. Is the fill-policy knob (`--fill`) wanted at all, or should flow be
   strictly native (balanced) with no micro-fit?
3. Sequencing: W2 pagination first, or W1+W3 (lint and page numbers) first?
4. Is the SPEC §8 licensing decision (MIT/Apache core, paid hosting) still
   current, or does the monetisation plan want revisiting?

## 10. What the prototype did NOT verify (do not read the numbers as proof)

The A/B in §1 is a real measurement, but it is a prototype, not the feature:

- **The CSSOM print-CSS removal stripped 0 rules** on that document — it carries
  no `@media print` or `@page` blocks, so the most security-critical part of
  flow mode (defeating a hostile document's own print CSS) is designed but
  **untested**. W2 must exercise it on a fixture that actively injects
  `@media print`/`@page` rules, and assert the output is unaffected by them.
- **The prototype printed the source document directly**, not tympan's clean
  template. It therefore does not yet prove that the template path (background
  measurement and painting, section reassembly, prelude, footer) survives in
  flow mode.
- **The stranded-heading detector flagged 1 page in each mode.** Inspection
  suggests that is the cover page, whose last line is legitimately a heading —
  i.e. a false positive. The detector needs a validated known-bad case and the
  documented cover/opener exclusion before its number means anything.
- **Page 5 of the flow result still ends at 44%** because a keep-together block
  did not fit. That is acceptable behaviour, and it is the case the `--fill`
  policy exists for; it will be inspected rather than shrunk away.
- The 5.7 s vs 0.5 s print-time gap is single-run on one document, not a
  benchmark. Treat it as a direction, not a number to publish.

## 11. W1 result — the same documents, measured by tympan itself (2026-10-16)

Section layout, default geometry, Kitch fixture set, via `tympan lint`:

| document | pages | mean fill | min fill | under target | shrunk for height | scaled for width |
|---|---|---|---|---|---|---|
| `01-brand-base.html` | 11 | 35% | 15% | 10 | 1 (page 9, 79%) | 10 |
| `03-subscription-plans.html` | 9 | 53% | 15% | 7 | 2 (pages 6, 8, 89%) | 7 |
| `pot-counter.print.html` | 4 | 26% | 12% | 4 | 0 | 4 |

Two findings the rasterized prototype could not have produced, both now
attributed in the report rather than inferred:

1. **Every page of every document is scaled to 0.902 by the WIDTH bound.** The
   document lays out at 774px; A4 portrait minus the default 1in of side margins
   is a 698px column, so `printSection`'s width fit shrinks the page before the
   height loop is ever consulted. Two consequences: type renders 10% smaller
   than authored on documents that would otherwise fit, and every page carries
   the blank slack that scaling created, which flatters nothing and wastes
   sheet. This is the whole-document finding
   `column-narrower-than-layout`, reported once, and the reason `scaledFor`
   exists: before it, this single mismatch read as nine separate "page shrank"
   warnings on one deck and buried the real per-page finding (pages 6 and 8 of
   `03-subscription-plans` are genuinely too tall at 89%).
   **It also changes the acceptance criteria in §4**: the fill targets are
   measured against the current, shrunken layout, so aligning the column should
   raise every fill number before any flow work is judged.
2. **Local images do not load at all.** A `<img src="logo.png">` beside the page
   is refused by our own security gate (`file://` reads are blocked by design),
   so it prints as blank space — measured, not suspected: `naturalWidth` is 0 in
   both the source page and the print template. `tympan lint` reports it as a
   `broken-asset` error. Fixing it (read local assets in Node and inline them as
   data URIs, then unblock nothing) belongs with W2's resource work, and it must
   land before any fidelity claim is made about local-asset documents.

Also settled by building the measurement: a **`<div>`-built section is not a
stranded heading** (the tag allowlist that ignored `div` produced a false
positive on pot-counter page 3, now pinned from both directions by a test), and
`pot-counter` reports 4 pages at 26% mean fill with **no** shrink — a full-bleed
deck, which is the case §4 says must not regress and the reason lint's fill rule
is a warning with `--target-fill 0` as the escape hatch.

## 12. W2-W4 delivered — the measured result (2026-10-21)

A/B on the Kitch fixture set, section (deck) mode vs `--flow`, fill read from
the produced PDF in BOTH modes, wall time per conversion:

| document | mode | pages | mean fill | min fill | bytes | wall | clipped / blank |
|---|---|---|---|---|---|---|---|
| `03-subscription-plans.html` | section | 10 | 0.626 | 0.128 | 424,050 | 6.6s | none / none |
| | **flow** | **8** | **0.810** | **0.491** | **132,203** | **2.2s** | none / none |
| `01-brand-base.html` | section | 11 | 0.386 | 0.128 | 566,714 | 7.2s | none / none |
| | **flow** | **6** | **0.810** | **0.098** | **245,651** | **2.5s** | none / none |
| `pot-counter.print.html` | section | 4 | 0.266 | 0.039 | 353,826 | 3.6s | none / none |
| | **flow** | **2** | **0.616** | **0.433** | **246,923** | **2.2s** | none / none |

Acceptance from §4, measured against these: `03` is ≤ 7 pages? **8 — close but
not met**, mean content-end 0.81 **met**; `01` ≤ 10 (8 hit)... `pot-counter`
pages at deck mode **unchanged (4 pages)**. Where the numbers miss the targets
written before the column fix, the honest note is that the prototype's §1
ink-coverage metric andalysis the shipped fill metric are not the same ruler;
the trend (41% → 81% on `01`, 4 → 2 sheets on `pot-counter` with DOUBLE the
mean fill) is unambiguous.

`pot-counter` full-bleed protection lives in `--layout auto`: measured, every
section already fills its sheet at full width, so auto keeps deck — prose
fixtures flip to flow. The choice and the arithmetic land in
`result.layoutChoice`.

Merge dedup, settled: the 28 font programs ARE duplicated in structure, but
their bytes are 99.7% unique (different glyph subsets per section print), so
the only trip-safe merge-level collapse is content-identical streams —
`dedupeIdenticalStreams` (56 objects, 6 KB on the measured deck, both modes).
The 2.9x byte win comes from printing ONCE, which is `--flow` — measured 3.2x
here.

## 13. The two open acceptance numbers, settled (2026-10-23)

Both §4 misses above are now measured to their causes — see the appendix
("The two open acceptance numbers") for the full evidence:

- **`01-brand-base`'s 9% page** is the document's trailing footer band on an
  otherwise full 5-sheet body; `--fill tight` closes it (6 → 5 pages at
  scale 0.98, mean 96%). Balanced keeps the tail and `flow-near-empty` names
  it — by design, not as a defect.
- **`03-subscription-plans`' 8th sheet** is the §4-sanctioned case itself:
  the CLASSIC/SIGNATURE comparison table (kept whole, `break-inside: avoid`)
  is taller than page 2's 532px slack. The ladder cannot reach 7 (at 0.97 the
  table is still ~983px against ~547px of slack; all candidates print 8).
  Splitting the table would trade the keep-together policy for one sheet —
  recorded as a deliberate non-fix. **§4's "≤ 7 pages" for `03` is re-ratified
  to "8 sheets, one sanctioned early-ending page, named in the report"**; the
  mean-fill (≥ 80%) criterion is met at 81%.

Also closed while measuring: the `--json` report now carries `layoutChoice`,
`fillPolicy`, `toc`, `outline` and `pageFooter` (§3.2's "states which mode was
used and why" was designed into the result but never serialized), and flow
pages are no longer judged by the section-mode fill target (`underfilled` is
null in flow; `flow-near-empty` owns sparse flow pages).

