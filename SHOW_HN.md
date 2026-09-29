# Show HN draft — tympan

## Title options (pick one; plain declarative works best on HN)

1. **Show HN: Tympan – Turn AI-generated HTML into clean, paginated PDFs**
2. **Show HN: One-section-per-page PDFs from AI-generated HTML, with verification built in**
3. **Show HN: Printing AI-generated HTML is broken, so I built a tool that checks its own output**

Recommended: #1 — names the tool, states the outcome, no hype.

## First comment (post structure)

> I kept asking AI assistants to build multi-section documents — investment
> decks, reports, creative briefs. They produce beautiful single-file HTML
> (React/Tailwind bundles, dark themes, Google Fonts). Then I tried to turn
> that HTML into a PDF and it fell apart every time: the page injects its own
> print CSS at runtime, which forces page breaks on every section, clamps
> covers to 100vh, and caps the page size with @page rules. Raw
> Playwright/Puppeteer print whatever that CSS says — so the output is
> slivers, split sections, and broken pagination.
>
> tympan (MIT, Node, zero config) works differently: it detects the document's
> semantic sections, clones each one into a clean minimal document that
> carries the static stylesheets and the page's own background — the injected
> print CSS never comes along — prints each section onto exactly one page
> (shrinking to fit in both dimensions when needed), and merges with vector
> rescaling, so text stays selectable and hyperlinks stay clickable. The
> document's hero becomes page 1, the footer lands on the last page, and the
> PDF is portrait A4 because that's the sheet a web document means. It also
> writes a bookmarks outline, sets real metadata, produces a smaller email
> variant, and verifies its own output (page count, last-page probe) with
> non-zero exit codes for CI.
>
> Two things I'd highlight. First, it never trusts a measurement: each
> section is printed, the artifact is inspected, and the scale shrinks until
> the one-page invariant holds — late-loading webfonts and Chromium's print
> rounding can't sneak a sliver second page past it. That bug shipped in an
> early version; it's pinned by a regression test that injects a webfont
> after the fonts-ready signal and asserts the section still holds one page.
> Second, identical input now produces byte-identical output — fixed
> timestamps, input-derived document ID, verified by converting the same
> 8-page document twice and hashing. And untrusted HTML is safe by default:
> documents you convert cannot read local files or reach private/cloud-
> metadata networks (every block is counted; `--offline` and `--allow-net`
> are the explicit escapes).
>
> Usage: `npx tympan brief.html` (landscape for slide decks:
> `--orientation landscape`)
>
> It is an opinionated layer on headless Chromium, not a new rendering engine —
> WeasyPrint-class tools can't run the JS these bundles need, and Gotenberg
> passes the page's own print CSS straight through, which is precisely the
> broken part.
>
> Repo with GIF, comparison table, and the full spec: <link>
> Happy to answer questions about the clean-document trick — that part took the
> longest to get right.

## Anticipated questions (prepare short answers)

- **Why the name?** Tympan: the padded sheet on a printing press that presses
  the paper against the type — this is the layer that presses HTML onto PDF
  pages. Full naming rationale and availability notes in SPEC.md §9.
- **Why not just `page.pdf()`?** The page's own print CSS wins; that's the bug, not the fix.
- **Why not screenshots?** Text must stay selectable and links clickable; screenshots are the fallback story, not the goal.
- **Windows/Linux support?** CI runs the conversion smoke on Ubuntu; Chromium discovery covers Win/mac/Linux cache layouts.
- **What about huge sections?** Shrink-to-fit scale keeps one section = one page (both dimensions); spills throw, so failures are loud.
- **Is output really deterministic?** Byte-identical for identical input under
  the exact-pinned engine (playwright is version-locked). A Chromium update is
  a rendering change by definition — the pin is the contract.
- **What does "secure by default" actually block?** Non-top-level file://
  reads (the converted page cannot read your disk) and requests to private,
  link-local, and cloud-metadata addresses. It cannot stop what Chromium
  itself renders from the source file — it stops the *page* from fetching
  what you didn't approve.
