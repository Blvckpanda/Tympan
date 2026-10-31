/**
 * measure.js — in-page DOM measurements, shared by the printer and the preview.
 *
 * These functions are serialized into a Chromium page (`page.evaluate`), so
 * each one carries no Node scope and takes exactly one argument. They live in
 * their own module because two callers now need the same numbers:
 *
 *   - the printer, which decides how much to shrink a section before printing
 *     it (`printSection` in pipeline.js);
 *   - `tympan preview`, which must show where the printer will cut WITHOUT
 *     printing anything — a preview that measures differently from the printer
 *     is a preview that lies, so it calls the same function.
 *
 * Measurements are CSS pixels (96/inch) taken on the layout the print will use
 * — the clean template at the page's own content width — never on a rasterized
 * PDF, where a painted background makes a sparse page read as full.
 */

/**
 * Measure the section currently in the document: its height, how wide its
 * content really is, what kind of block it ends on, and which images failed.
 *
 * Serialized into the page by pipeline.js and preview.js.
 * @param {string} rootSelector element holding the section ('main' for the
 *   clean template)
 * @returns {{h: number, w: number, lastBlockKind: string|null,
 *   brokenImages: Array<{src: string, alt: string}>}}
 */
export function measureBlockInPage(rootSelector) {
  const el = document.querySelector(rootSelector || 'main');
  const r = el ? el.getBoundingClientRect() : { height: 400, width: 800 };
  // Width of the CONTENT, not of the window.
  //
  // This used to take `document.documentElement.scrollWidth`, which can never
  // be smaller than the viewport tympan itself created — so a 700px document
  // measured 774px (the viewport) and every page was printed at scale 0.902 to
  // "fit" a 698px column. Proved 2026-10-21: a main{max-width:700px} fixture
  // reported widthPx 774.
  //
  // The element's own scrollWidth ignores the window and still catches content
  // that overflows the column (wide images, pre, wide tables) — printing that
  // would clip the right edge.
  const w = Math.max(r.width, el ? el.scrollWidth || 0 : 0);

  // Kind of the last block on the page: a sheet that ends on a heading strands
  // the section it introduces — the reader turns the page to find the content
  // the heading promised. The scan runs backwards over leaf-ish blocks, so the
  // deepest last element in document order wins (a wrapper div is never the
  // answer; its content is).
  let lastBlockKind = null;
  if (el) {
    const nodes = Array.from(
      el.querySelectorAll('h1,h2,h3,h4,h5,h6,p,div,ul,ol,table,figure,pre,blockquote,img,svg')
    );
    for (let i = nodes.length - 1; i >= 0; i--) {
      const rr = nodes[i].getBoundingClientRect();
      if (rr.height <= 0 || rr.width <= 0) continue;
      const tag = nodes[i].tagName.toUpperCase();
      lastBlockKind = /^H[1-6]$/.test(tag)
        ? 'heading'
        : tag === 'TABLE'
          ? 'table'
          : tag === 'FIGURE' || tag === 'IMG' || tag === 'SVG'
            ? 'figure'
            : 'text';
      break;
    }
  }

  // `complete` is true for a FAILED image too, and a failed image prints as
  // blank space. Measured after the caller has waited for images to settle.
  const brokenImages = Array.from(document.images)
    .filter((i) => i.complete && i.naturalWidth === 0)
    .map((i) => ({ src: i.currentSrc || i.src || '', alt: i.alt || '' }))
    .slice(0, 12);

  return { h: r.height, w, lastBlockKind, brokenImages };
}
