/**
 * auto.js — the `--layout auto` chooser (plan v0.8, section 3.2).
 *
 * Everything it consumes is a measurement: per-section heights and the
 * initial fit each section needs, exactly the numbers `measureSections`
 * collects before a single byte of PDF exists. Nothing here prints.
 *
 * The rule, from the plan: use flow when one-block-per-page would waste more
 * than the allowed fraction of the document's sheet area, or when any section
 * needs scaling below the floor to hold its sheet; otherwise deck is correct
 * and gets to stay. Both thresholds are the caller's knobs, and the report
 * carries what was picked AND the arithmetic behind it.
 */

const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const round3 = (n) => Math.round((n || 0) * 1000) / 1000;

/**
 * Greedy flow estimate: pack section heights onto usable-size shelves.
 * Deliberately optimistic about keep-together (a `break-inside: avoid` block
 * taller than the remaining space starts a new page), so the real flow print
 * can only need MORE pages, never fewer — a bad estimate errs toward deck,
 * not toward flow.
 * @param {number[]} heights px
 * @param {number} usable px
 * @returns {number} estimated page count (>= 1)
 */
export function greedyFlowPages(heights, usable) {
  if (!(usable > 0)) return 1;
  // Shelf simulation: `space` is what is left on the current shelf. A block
  // that fits takes it; a smaller-than-a-shelf block moves whole (a gap is
  // left behind — the estimate is optimistic in the keep-together direction,
  // so it can never argue FOR flow); an oversized block fills the rest of the
  // shelf and continues on fresh ones, exactly how Chromium fragments it.
  let pages = 1;
  let space = usable;
  for (const h0 of heights) {
    let h = Math.max(0, h0);
    if (!(h > 0)) continue;
    if (h <= space) {
      space -= h;
      continue;
    }
    pages++;
    space = usable;
    while (h > space) {
      h -= space;
    }
    space -= h;
  }
  return Math.max(1, pages);
}

/**
 * Choose the layout from measurements.
 * @param {object} input
 *   {sections: Array<{heightPx, scaleUsed?}>, usablePx, targetFill?, scaleFloor?}
 * @returns {object} {picked, reason, deckFill, flowFill, deckPages, flowPages}
 */
export function chooseLayout({ sections, usablePx, targetFill = 0.7, scaleFloor = 0.95 }) {
  const list = sections || [];
  const usable = usablePx > 0 ? usablePx : 1045;
  if (!list.length) {
    return { picked: 'deck', reason: 'nothing to lay out', deckFill: 0, flowFill: 0, deckPages: 0, flowPages: 1 };
  }
  const heights = list.map((s) => Math.max(0, s.heightPx || 0));
  // Deck: one section per sheet, shrunk just enough — the SAME initial fit
  // printSection starts from, so the estimate and the printer agree about
  // what "fits" means.
  const deckContent = list.reduce(
    (a, s) => a + Math.min(usable, (s.heightPx || 0) * (s.scaleUsed ?? Math.min(1, usable / Math.max(1, s.heightPx || 1)))),
    0
  );
  const deckFill = deckContent / (list.length * usable);
  const minScale = Math.min(...list.map((s) => s.scaleUsed ?? 1));
  const total = heights.reduce((a, b) => a + b, 0);
  const flowPages = greedyFlowPages(heights, usable);
  const flowFill = Math.min(1, total / (flowPages * usable));

  const underfilled = deckFill < targetFill;
  const narrow = minScale < scaleFloor;
  let picked;
  let reason;
  if (underfilled && narrow) {
    picked = 'flow';
    reason = `sections fill only ${pct(deckFill)} of their sheets and the ones that do not fit shrink to ${pct(minScale)}`;
  } else if (underfilled) {
    if (flowFill > deckFill) {
      picked = 'flow';
      reason = `sections fill only ${pct(deckFill)} of their sheets; one flowing print would carry ${pct(flowFill)}`;
    } else {
      picked = 'deck';
      reason = `sections run sparse (${pct(deckFill)}), but flowing the same blocks would carry only ${pct(flowFill)}`;
    }
  } else if (narrow) {
    picked = 'flow';
    reason = `content is laid out ${pct(minScale)} of its column and starts shrinking per sheet; flowing restores scale 1`;
  } else {
    picked = 'deck';
    reason = `sections already fill ${pct(deckFill)} of their sheets at full width`;
  }
  return {
    picked,
    reason,
    deckFill: round3(deckFill),
    flowFill: round3(flowFill),
    deckPages: list.length,
    flowPages,
  };
}
