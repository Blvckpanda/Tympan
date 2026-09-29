# Show HN draft — tympan

## Title options (pick one; plain declarative works best on HN)

1. **Show HN: Tympan – Turn AI-generated HTML into clean, paginated PDFs**
2. **Show HN: One-section-per-page PDFs from AI-generated HTML, with verification built in**
3. **Show HN: Printing AI-generated HTML is broken, so I built a tool that checks its own output**

Recommended: #1 — names the tool, states the outcome, no hype.

## First comment (post structure)

> I kept asking AI assistants to build multi-section documents — investment
> decks, reports, proposals. They produce beautiful single-file HTML
> (React/Tailwind bundles). Then I tried to turn that HTML into a PDF and it
> fell apart every time: the page injects its own print CSS at runtime, which
> forces page breaks on every section, clamps covers to 100vh, and caps the
> page size with @page rules. Raw Playwright/Puppeteer print whatever that CSS
> says — so the output is slivers, split sections, and broken pagination.
>
> tympan (MIT, Node, zero config) works differently: it detects the document's
> semantic sections, clones each one into a clean minimal document that carries
> only the static stylesheets — the injected print CSS never comes along —
> prints each section onto exactly one page, and merges the pages with vector
> rescaling, so text stays selectable and hyperlinks stay clickable. It also
> writes a bookmarks outline, sets PDF metadata from the source, produces a
> smaller email variant, and verifies its own output (page count, last-page
> probe) with non-zero exit codes for CI.
>
> The part I'd highlight: it never trusts a measurement. Each section is
> printed, the artifact is inspected, and the scale shrinks until the
> one-page invariant holds — late-loading webfonts and Chromium's print
> rounding can't sneak a sliver second page past it. That exact bug shipped
> in an earlier version; it's now pinned by a regression test that injects
> a webfont after the fonts-ready signal and asserts the section still
> holds one page.
>
> Usage: `npx @blvckpanda/tympan deck.html`
>
> It is an opinionated layer on headless Chromium, not a new rendering engine —
> WeasyPrint-class tools can't run the JS these bundles need, and Gotenberg
> passes the page's own print CSS straight through, which is precisely the
> broken part.
>
> Repo with GIF and comparison table: <link>
> Happy to answer questions about the clean-document trick — that part took the> longest to get right.

## Anticipated questions (prepare short answers)

- **Why the name?** Tympan: the padded sheet on a printing press that presses
  the paper against the type — this is the layer that presses HTML onto PDF
  pages. Full naming rationale and availability notes in SPEC.md §9.
- **Why not just `page.pdf()`?** The page's own print CSS wins; that's the bug, not the fix.
- **Why not screenshots?** Text must stay selectable and links clickable; screenshots are the fallback story, not the goal.
- **Windows/Linux support?** CI runs the conversion smoke on Ubuntu; Chromium discovery covers Win/mac/Linux cache layouts.
- **What about huge sections?** Shrink-to-fit scale keeps one section = one page; spills throw, so failures are loud.
- **Is output deterministic?** Not byte-for-byte yet (Chromium embeds varying
  IDs/timestamps) — it's the v0.5 milestone, and the claim in the README is
  scoped to it honestly.
