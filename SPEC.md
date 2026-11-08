# Tympan — Product Spec

> A CLI that converts HTML to PDF. Working name: **Tympan** (provisional, see §9).

## 1. Positioning

**One line:** A deterministic, secure, fast HTML-to-PDF converter that produces standards-compliant, accessible PDFs with zero configuration.

**Users:** developers generating invoices, reports, contracts, receipts, resumes, and books from HTML, in CI, on servers, and in serverless.

**The wedge (why it wins):**
1. **Reproducible:** same input, same bytes.
2. **Safe on untrusted HTML by default** (SSRF and local-file protection).
3. **Diagnostics** that say exactly what broke and where.
4. **Correct standards output:** tagged PDF, PDF/A, small files.

**Non-goals:** our own layout engine, a GUI, a general PDF editor, Word/PowerPoint conversion, OCR, AI in the render path.

## 2. Principles

- Great output with zero flags; every default is a considered choice.
- Determinism over cleverness. Anything non-deterministic is opt-in.
- Fail loudly with actionable errors; never silently produce a broken PDF.
- Secure by default; loosening is explicit.
- Build on Chromium; spend effort where it doesn't already excel.
- Ship in phases. Each phase must be useful on its own.

## 3. Architecture

```
CLI / API  →  Core pipeline  →  Engine adapter (Chromium via CDP)
                    ↓
            PDF post-processor  →  Output (file / stdout)
```

- **Engine:** Chromium via DevTools Protocol, version pinned and auto-managed (download on first run, checksum-verified).
- **Core pipeline:** load → wait (deterministic) → print → verify → post-process.
- **Post-processor:** metadata, outline, PDF/A, optimization, signing, merge/split. Operates on the PDF after Chromium prints it.
- **Daemon mode:** persistent browser pool for warm, parallel conversions.
- **Security layer:** request interception, network policy, resource limits, sandbox.

## 4. Phases

### Phase 0: Spike
- Drive pinned Chromium, print a page, implement the wait strategies.
- Build a 20-document corpus (invoice, report, RTL, CJK, tables, web fonts).
- Baseline against Puppeteer output for fidelity and speed.

**Exit:** corpus renders correctly and reproducibly.

### Phase 1 (v1): Reliable core
- Input: file, URL, stdin, glob. Output: file or stdout.
- Print options: page size, margins, orientation, backgrounds, header/footer templates, page numbers, print/screen media.
- Deterministic waits: network idle, fonts ready, `--wait-for <selector>`, custom ready signal, timeout.
- Security defaults: block `file://`, block private/metadata IP ranges, network allowlist, JS toggle, offline mode, resource limits.
- Diagnostics: console errors, failed requests, missing fonts, overflow warnings, `--strict`, JSON output, meaningful exit codes, `doctor` command.
- Determinism: fixed timestamps and IDs, reproducible bytes.
- Presets (default, invoice, report) and a config file.
- Auto bookmarks from headings, document metadata.
- Batch mode with parallelism and a warm browser.
- Distribution: npm package, Docker image; Linux, macOS, Windows.

**Exit:** 1,000 repeated renders produce identical output; the SSRF and file-read test suite passes; published benchmarks.

### Phase 2 (v2): Standards and size
- Tagged PDF and accessibility validation (verify against PDF/UA checks).
- PDF/A output, XMP metadata, PDF/A-3 with embedded XML (Factur-X/ZUGFeRD).
- File-size optimization (resource dedupe, object streams, image handling).
- Linearization, encryption, digital signatures (PAdES), watermark, stamping.
- Merge/split/compose with unified page numbering, generated TOC, cover pages.
- `lint`: print-CSS and accessibility problems.
- `test`: visual and text regression against baselines, for CI.

**Exit:** the corpus passes an external validator (e.g. veraPDF); measured size reduction vs baseline.

### Phase 3 (v3): Typesetting and templating
- Paged-media features the engine lacks at that point (footnotes, running headers, cross-references, TOC leaders, named pages). **Check what Chromium supports natively before building anything.**
- Smart pagination: no split table rows, repeated table headers, keep headings with content, no orphaned captions.
- Templating with data merge (JSON/CSV) for mass generation.
- HTML forms to fillable fields.
- Redaction, CMYK / PDF/X for print.

**Exit:** a 500+ page book and a 10k-invoice batch both render correctly within agreed time and memory limits.

### Phase 4: Ecosystem
- GitHub Action, HTTP server mode, Python and Rust bindings.
- wkhtmltopdf-compatible flag mode and migration guides.
- Docs site, template gallery, playground.
- Optional, opt-in AI extras (alt-text generation, layout-issue explanations).

## 5. CLI sketch

```
tympan input.html -o out.pdf        # convert
tympan build "docs/**/*.html" -d dist/   # batch
tympan serve                         # HTTP / daemon mode
tympan preview input.html            # live preview with page-break overlay
tympan lint input.html               # print-CSS and a11y checks
tympan test                          # visual/text regression
tympan doctor                        # environment and engine check
```

## 6. Quality bar

- **Corpus:** 200+ real documents (invoices, reports, resumes, books, RTL, CJK).
- **Checks:** pixel diff, text-extraction diff, external PDF validators, flake test (1,000 runs).
- **Security:** hostile-HTML suite (SSRF, `file://`, redirects, DNS rebinding, resource exhaustion).
- **Performance:** cold vs warm start, throughput, memory on large documents; published and tracked per release.
- **Stability:** semantic versioning that covers rendering changes; pinned engine per release.

## 7. Risks

- Chromium is a big dependency; version drift changes output. Mitigation: pin, test, document.
- Chromium's paged-media support keeps evolving; polyfills may become redundant. Verify before building.
- Scope creep: the wedge is reliability and correctness, not feature count.
- Established competition (Prince, WeasyPrint, Puppeteer/Playwright, Gotenberg, Paged.js, Vivliostyle). Study each before positioning.

## 8. Open decisions

- **Implementation language:** TypeScript (mature CDP libraries, fastest iteration) vs Rust (single binary for the CLI, though Chromium is still required). Leaning TypeScript for v1.
- **License:** open-source core (MIT or Apache-2.0); paid tier for hosting and enterprise features.
- **Browser distribution:** download on first run vs bundle.
- **Scope of v1:** hold to Phase 1. Do not pull Phase 2+ items forward.

## 9. Naming

Recommended: **Tympan**, the padded sheet on a printing press that presses the paper against the type. Command: `tympan`.

Availability checked 2026-09-29: free on npm, PyPI, and crates.io; no HTML-to-PDF project of that name found on GitHub. Not checked: domains, trademarks.

Considered and rejected: Deckle (an HTML-to-PDF project already uses the name on PyPI), Quarto (well-known existing publishing CLI), Vellum (known book-formatting app), Folio (too generic).

---

## 10. Adoption decisions (2026-09-29)

This spec is the project's charter as of v0.4.0. Where practice differs from
the letter of the spec, the deviation and its reason are recorded here.

**Adopted as written**

- Positioning, principles (§1–2), and the phased plan (§4) — including the
  spec's own anti-scope-creep pushback: v1 stays Phase 1, nothing pulled
  forward from Phase 2.
- Deterministic waits, security defaults, fixed timestamps/IDs, and the
  corpus + flake-test exit criteria land on the v0.5/v0.6 roadmap, not
  retrofitted silently.
- `test` / `doctor` were held out of v1's CLI surface and then landed early
  (v0.6/v0.7) because the spec's own Phase 1 diagnostics list demands them:
  "console errors, failed requests, missing fonts, overflow warnings, `--strict`,
  JSON output, meaningful exit codes, `doctor` command". `tympan lint` (built
  2026-10-16) is that list's diagnostics half — failed requests, overflow
  warnings, `--strict`, JSON — and **not** the Phase 2 half of §4's `lint`
  item, which is accessibility validation; its accessibility rules shipped
  as `lint --a11y` in the v0.9.0 line (the standards OUTPUT half ships
  separately — see `--tagged` above).
- `--tagged`, with `--flow`, shipped 2026-11-04: Phase 2's tagged-PDF item at
  Chromium's fidelity. A flow print is one print per document, so the
  engine's structure tag tree (`/StructTreeRoot` with marked content, real
  heading/list/link semantics) survives whole; the pipeline's deterministic
  tail adds what the engine does not own — `/Lang` from the page's
  `<html lang>` (deleted, never filled with the printing machine's locale,
  when the source names none — that gap is `lint --a11y`'s
  `a11y-html-lang`), `ViewerPreferences /DisplayDocTitle true`, and an XMP
  packet with fixed dates, the tympan producer and the PDF/UA-1 identifier
  (`pdfuaid:pdfuaid 1`). Deck mode REFUSES the flag — it merges one print
  per section, so its pages share no structure tree. The suite verifies
  structurally (`inspectTagged`: tree, MarkInfo, /Lang, identifier,
  byte-identity over repeated runs).  **§6's "verify against PDF/UA checks" is met with a REAL validator run and
  an honest residue:** veraPDF 1.30.3 (PDF/UA-1 profile, run on the fixture
  output) → **105 of 106 rules passed; 809 of 811 checks**. The single
  failing rule (7.1, "content shall be marked as Artifact or tagged as real
  content", 2 checks) is the engine's tagged writer at its pin leaving the
  pre-content page fill and clip operations unmarked — tympan does not
  synthesize tagging to repair its engine. Two failures tympan OWNS were
  measured and fixed against the validator: the identifier is written as
  `pdfuaid:part 1` (veraPDF's PDFUAIdentification schema property), and
  every visible link annotation now carries its own URI as the alternate
  description of 7.18.1/7.18.5 (Chromium's print emits Link annots with no
  Contents and no Alt entry).
- `--pdfa`, with `--flow`, shipped 2026-11-04: PDF/A-2b carried by real data,
  dependency-free. The catalog gets a `GTS_PDFA1` OutputIntent bound to the
  sRGB characterization embedded verbatim from `assets/icc/sRGB-v2-micro.icc`
  — 456 bytes, ICC v2, CC0, from saucecontrol/Compact-ICC-Profiles (seen in
  `assets/icc/README.md` with the sha256 prefix). NOT synthesized in code:
  an sRGB claim means a measured characterization. The XMP packet pairs the
  pdfaid identification (`pdfaid:part 2`, `pdfaid:conformance B`) with the
  tail's fixed dates/producer. Deck mode refuses the flag for the same
  finished-single-print reason as `--tagged`. **Measured against the
  validator: veraPDF 1.30.3, PDF/A-2b → FULLY COMPLIANT on both artifacts
  tried (fixture: 144 of 144 rules, 1350 of 1350 checks; the ai-deck smoke
  input: 144 of 144 rules, 1059 of 1059 checks).** One measured constraint,
  recorded not argued away: the PDF/A-2 model (6.6.2.3.1) rejects the
  pdfuaid identification schema in the XMP — even DECLARED exactly the way
  veraPDF's own metadata fixer declares it (nested rdf:Description form,
  pdfx fields) — and rejects the pdf:ExtensionSchema container property
  itself; veraPDF's `--fixmetadata` output fails the same rule. So one
  packet attests ONE claim: `--pdfa` packets carry only predefined-schema
  properties (no pdfuaid entry), and `--tagged --pdfa` is refused at flag
  level. §4's `PDF/A-3 with embedded XML (Factur-X/ZUGFeRD)` remains as
  exactly that — the factur-X embedded-XML variant, a further, separate
  build on top of this tail.
- `tympan preview` (Phase 1 sketch, §5) shipped 2026-10-16: one paper-sized
  sheet per section with the text area, the shrink factor and the fill line
  drawn, measured by the printer's own code path (a test pins that the preview
  and the converter agree page for page).
- `tympan serve` (Phase 4 sketch, §5) exists as a spike with per-tenant keys, a
  bounded queue and a Dockerfile — deliberately NOT a hosted product. Its
  production-shaped seams shipped 2026-11-07 behind one opt-in flag,
  `--state-dir` (env `TYMPAN_SERVE_STATE_DIR`): keys hashed at rest with live
  revocation (`serve keys add/list/revoke`), a job journal under `jobs/` whose
  incomplete rows are re-queued on restart (at-least-once; a job whose payload
  or result vanished fails with the reason, never hangs), and per-tenant
  metering (submitted/succeeded/failed, pages, bytes, convert ms) persisted to
  `meter.json` and reported on `/v1/me`. Deliberately still absent — and this
  is the decided boundary, not a TODO — a database, an external broker and
  object storage: the state is a directory of JSON files, atomic writes
  (tmp+rename), zero new dependencies, single machine. [docs/SERVE.md](docs/SERVE.md)
  names the remaining paid-tier work (plans, invoicing, fair-share, audit). The §6
  quality-bar items this makes measurable — published per-release numbers on a
  corpus — are now real: `scripts/corpus.mjs` writes
  [docs/BENCHMARKS.md](docs/BENCHMARKS.md). Since 2026-11-08 one run measures
  the modes the tree ships — `scripts/corpus.mjs --modes section,flow,tagged,pdfa`
  — against the same 52-document corpus, geometry and warm browser, so the
  flags are compared rather than argued: section prints 340 pages at 41% mean
  fill (329 under target), `--flow` 149 pages at 65% (none under target), and
  the standards tails keep flow's layout while adding bytes (tagged 4.4 MB,
  pdfa 2.5 MB, flow 2.4 MB). §6's "200+ real documents" remains unmet: the
  corpus is 52 *generated* documents, and the report says so.

**Deviations**

1. **Network policy: blocklist-by-default, not allowlist-by-default.**
   The wedge users (AI-generated decks) legitimately load Google Fonts and
   CDNs; an allowlist default would break the zero-flag promise on day one.
   v0.5 ships a default blocklist — deny `file://`, private and
   cloud-metadata IP ranges — with offline mode and strict allowlists as
   opt-in flags. The spec's security goals hold; the default is reversed.
2. **Engine: Playwright's Chromium is the pinned engine contract.** No
   auto-downloader for now; instead the `playwright` dependency is
   exact-pinned (`1.63.0`, no caret) so output cannot drift silently between
   releases. §1's "pinned, auto-managed" is satisfied by the lockfile
   contract first, tooling later.
3. **Language: ESM JavaScript plus hand-written `types/index.d.ts` through
   v1** (the spec leans TypeScript). No mid-rebrand rewrite; revisit after
   v1.
4. **"Byte-identical output" is promised only under the pinned engine on
   the same OS and font stack** — stated honestly rather than absolutely,
   and only after the fixed-timestamps/IDs pass (v0.5) makes it true.
5. **Section-per-page stays the default strategy** for multi-section
   documents — it is where the closed-loop guarantee lives — with the
   whole-document print path as the single-section fallback. The spec's
   general converter is the superset this grows into, not a pivot.

**Additions the spec misses**

1. **Closed-loop output verification is a core principle, not an
   implementation detail.** Never trust a measurement: print the artifact,
   inspect it, retry with a smaller scale until the invariant holds. The
   shrink-to-fit loop in `printSection` (print → count pages → shrink 10%
   until one page) is the template for every future "the engine said so"
   risk: metadata, determinism, tagging.
2. **Probe assertions (`--probe`)** as a CI contract: a text string that
   must appear on the last page, with a non-zero exit on miss.
3. **The email-optimized variant** (in-DOM image downscale; smaller PDF
   for HTML email) as a first-class output.
