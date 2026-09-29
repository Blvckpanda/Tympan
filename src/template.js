/**
 * template.js — clean-document builder.
 *
 * The trick that makes tympan work where raw Playwright fails: AI bundles
 * inject print CSS at runtime (`break-before/after: page`, `100vh` clamps,
 * `@page` caps). Rendering the original document always fragments. Instead,
 * each section is printed from a fresh minimal document that carries only:
 *   - the page's static stylesheets (first <style> tag + head <link>s)
 *   - a margin reset + a centered content column at the source's own width
 * No framework runtime, no injected print CSS, no @page rules.
 */
/** Content width at which the source page is laid out (landscape content @96dpi). */
export const CONTENT_W = 1026;

/** Fallback width of the centered content column when detection finds nothing. */
export const DEFAULT_CONTENT_MAX_WIDTH = 870;

/**
 * Serialized into page.evaluate by pipeline.js. Builds the clean-document
 * shell; `maxWidthPx` sizes the centered content column.
 * @param {number} maxWidthPx
 */
export function buildCleanTemplate(maxWidthPx) {
  // Fallback must be a literal: this function is serialized into the browser
  // and cannot see Node-module constants.
  const max = Number.isFinite(maxWidthPx) && maxWidthPx > 0 ? Math.round(maxWidthPx) : 870;
  const doc = document.implementation.createHTMLDocument('tympan');

  const firstStyle = document.querySelector('style');
  if (firstStyle) {
    const st = document.createElement('style');
    st.textContent = firstStyle.textContent;
    doc.head.appendChild(st);
  }

  const links = Array.from(document.querySelectorAll('head link[rel="stylesheet"]'));
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href) continue;
    try {
      const clone = document.createElement('link');
      clone.rel = 'stylesheet';
      clone.setAttribute('href', new URL(href, location.href).href);
      doc.head.appendChild(clone);
    } catch (e) { /* skip unresolvable href */ }
  }

  const main = document.createElement('main');
  doc.body.appendChild(main);

  const reset = document.createElement('style');
  reset.textContent = 'html,body{margin:0;padding:0;background:#fff} '
    + 'main{margin:0 auto;max-width:' + max + 'px}';
  doc.head.appendChild(reset);

  return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
}

/**
 * Serialized into page.evaluate by pipeline.js: detect the source document's
 * content max-width. Prefers the computed max-width of the container that
 * holds the most section-like children (AI pages center a max-width column);
 * falls back to that container's laid-out width, then the default.
 * @param {number} fallbackWidth returned when no container is found
 * @returns {number} max-width in px
 */
export function detectContentMaxWidthInPage(fallbackWidth) {
  const candidates = Array.from(
    document.querySelectorAll('main, [role="main"], body > div')
  );
  let best = null;
  for (const el of candidates) {
    const kids = el.querySelectorAll('section, article, [data-page], [data-slide]').length;
    if (!kids) continue;
    if (!best || kids > best.kids) best = { el, kids };
  }
  if (!best) return fallbackWidth;
  const cs = getComputedStyle(best.el);
  const mw = parseFloat(cs.maxWidth);
  if (cs.maxWidth && cs.maxWidth !== 'none' && Number.isFinite(mw) && mw > 0) {
    return Math.round(mw);
  }
  const w = best.el.getBoundingClientRect().width;
  if (Number.isFinite(w) && w > 0) return Math.round(w);
  return fallbackWidth;
}
