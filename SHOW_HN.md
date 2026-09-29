# Show HN draft — aipdf

## Title options (pick one; plain declarative works best on HN)

1. **Show HN: Aipdf – Turn AI-generated HTML into clean, paginated PDFs**
2. **Show HN: One-section-per-page PDFs from AI-generated HTML**
3. **Show HN: Printing AI-generated HTML is broken, so I built a tool that fixes it**

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
> aipdf (MIT, Node, zero config) works differently: it detects the document's
> semantic sections, clones each one into a clean minimal document that carries
> only the static stylesheets — the injected print CSS never comes along —
> prints each section onto exactly one page (shrinking just enough when a
> section is tall), and merges the pages with vector rescaling, so text stays
> selectable and hyperlinks stay clickable. It also writes a bookmarks outline,
> sets PDF metadata from the source, produces a smaller email variant, and
> verifies its own output (page count, last-page probe) with non-zero exit
> codes for CI.
>
> Usage: `npx aipdf deck.html`
>
> It is an opinionated layer on headless Chromium, not a new rendering engine —
> WeasyPrint-class tools can't run the JS these bundles need, and Gotenberg
> passes the page's own print CSS straight through, which is precisely the
> broken part.
>
> Repo with GIF and comparison table: <link>
> Happy to answer questions about the clean-document trick — that part took the
> longest to get right.

## Anticipated questions (prepare short answers)

- **Why not just `page.pdf()`?** The page's own print CSS wins; that's the bug, not the fix.
- **Why not screenshots?** Text must stay selectable and links clickable; screenshots are the fallback story, not the goal.
- **Windows/Linux support?** CI runs the conversion smoke on Ubuntu; Chromium discovery covers Win/mac/Linux cache layouts.
- **What about huge sections?** Shrink-to-fit scale keeps one section = one page; spills throw, so failures are loud.
