/**
 * detect.js — section detection for arbitrary AI-generated HTML documents.
 *
 * The DOM-side step (`detectSectionsInPage`) is serialized into page.evaluate
 * by the pipeline, so it must be DOM-only with no Node imports. It is exported
 * anyway so unit tests can run it against jsdom.
 *
 * Strategy ladder (first match wins):
 *   1. explicit selector (option)      — confidence 1.0, strategy 'selector'
 *   2. section.page-section            — 0.9, 'page-section-class' (deck-style)
 *   3. [data-page], then [data-slide]  — 0.85, 'data-attribute'
 *   4. <section>/<article> children of the widest main-ish container
 *                                      — 0.6, 'semantic-children'
 *   5. whole document as one section   — 0.2, 'whole-document'
 */
export const DETECTION_LADDER = [
  'selector',
  'page-section-class',
  'data-attribute',
  'semantic-children',
  'whole-document',
];

/**
 * DOM-side detection step. Serialized into page.evaluate by the pipeline and
 * directly callable under jsdom in tests.
 * @param {string} [selector] optional explicit CSS selector
 */
export function detectSectionsInPage(selector) {
  // Section title for the PDF outline: first heading's text, else data-label,
  // aria-label, or title attr, else null. Capped so mega-headings don't bloat
  // the outline panel.
  const titleOf = (el) => {
    const h = el.querySelector('h1, h2, h3, h4, h5, h6');
    const raw =
      (h && h.textContent) ||
      el.getAttribute('data-label') ||
      el.getAttribute('aria-label') ||
      el.getAttribute('title');
    const t = raw ? raw.replace(/\s+/g, ' ').trim().slice(0, 80) : null;
    return t || null;
  };

  if (selector) {
    const nodes = Array.from(document.querySelectorAll(selector));
    if (nodes.length) {
      return {
        strategy: 'selector',
        confidence: 1,
        sections: nodes.map((el, i) => ({
          html: el.outerHTML,
          id: el.id || `${selector}#${i + 1}`,
          title: titleOf(el),
        })),
      };
    }
  }

  const byClass = Array.from(document.querySelectorAll('section.page-section'));
  if (byClass.length) {
    return {
      strategy: 'page-section-class',
      confidence: 0.9,
      sections: byClass.map((el, i) => ({
        html: el.outerHTML,
        id: el.id || `section-${i + 1}`,
        title: titleOf(el),
      })),
    };
  }

  for (const attr of ['data-page', 'data-slide']) {
    const nodes = Array.from(document.querySelectorAll(`[${attr}]`));
    if (nodes.length) {
      return {
        strategy: 'data-attribute',
        confidence: 0.85,
        sections: nodes.map((el, i) => ({
          html: el.outerHTML,
          id: el.getAttribute(attr) || `${attr}-${i + 1}`,
          title: titleOf(el),
        })),
      };
    }
  }

  // <section>/<article> children of the widest main-ish container. "Widest"
  // wins because AI pages often nest decorative wrappers; the true content
  // container is the one laid out at full content width.
  const containers = Array.from(
    document.querySelectorAll('main, [role="main"], body > div')
  );
  let best = null;
  for (const container of containers) {
    const kids = Array.from(
      container.querySelectorAll(':scope > section, :scope > article')
    );
    if (!kids.length) continue;
    const width = container.getBoundingClientRect().width;
    if (!best || width > best.width) best = { width, kids };
  }
  if (best) {
    return {
      strategy: 'semantic-children',
      confidence: 0.6,
      sections: best.kids.map((el, i) => ({
        html: el.outerHTML,
        id: el.id || `section-${i + 1}`,
        title: titleOf(el),
      })),
    };
  }

  // Fallback: the whole document is one section (still gets the clean-doc
  // treatment and one-page auto-fit, so even an unknown page produces a
  // sane, verifiable single-page PDF).
  return {
    strategy: 'whole-document',
    confidence: 0.2,
    sections: [
      {
        html: document.body.innerHTML,
        id: 'document',
        title: titleOf(document.body) || document.title || null,
      },
    ],
  };
}

/** Summary line for CLI/progress output: `12 sections (data-attribute, 85%)`. */
export function describeDetection(detection) {
  const n = detection.sections.length;
  const pct = Math.round(detection.confidence * 100);
  return `${n} section${n === 1 ? '' : 's'} (${detection.strategy}, ${pct}%)`;
}
