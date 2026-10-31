/**
 * presets.js — `--preset deck|report|book|invoice|contract` (plan W3).
 *
 * A preset is a documented BUNDLE of option defaults, resolved before
 * explicit flags are applied — a user who passes BOTH gets their explicit
 * flag, every time. Every mapping lives in this table (and only here), so
 * the CLI's job is one lookup, and a test can pin the whole set in one place.
 *
 * Which document wants what, briefly:
 *   deck      — slide-deck or designed full-bleed pages: one block per sheet
 *               is CORRECT (pot-counter measures 100% fill), so nothing moves.
 *   report    — top-down prose: flow + page numbers, nothing else.
 *   book      — report plus the furniture books carry: a Contents page, a
 *               running footer (re-set at runtime to the document title),
 *               wider top/bottom margins.
 *   invoice   — a short, dense business document: section layout (each block
 *               is already near a full sheet), tightened side margins.
 *   contract  — agreement prose with the signatures' page identity intact:
 *               flow + page numbers + running footer, section rules left at
 *               defaults, no TOC.
 */

export const PRESETS = {
  deck: {},
  report: { flow: true, pageNumbers: true },
  book: {
    flow: true,
    pageNumbers: true,
    toc: true,
    footerFromTitle: true,
    margins: { top: 0.6, bottom: 0.6 },
  },
  invoice: { margins: { left: 0.4, right: 0.4 } },
  contract: { flow: true, pageNumbers: true, footerFromTitle: true },
};

export const PRESET_NAMES = Object.keys(PRESETS);

/**
 * Resolve a preset name into option defaults.
 * @param {string} name
 * @returns {object} defaults to merge UNDER explicit options; {} for 'deck'
 */
export function presetDefaults(name) {
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(`unknown preset "${name}" (known presets: ${PRESET_NAMES.join(', ')})`);
  }
  return { ...preset };
}

/**
 * Fold a preset over user options. Explicit user values always win — via the
 * `??` chain, not assignment, so `undefined` stays a preset decision and a
 * user-set value is never clobbered.
 *
 * `footerFromTitle` is special: it is NOT itself an option. It resolves at
 * run time, when the source document's <title> is known, into a static
 * running-footer string — kept separate because <title> is metadata a preset
 * cannot predict.
 *
 * @param {string} name preset name ('' | undefined = no preset)
 * @param {object} [options] explicit user options
 * @returns {object} merged options. Same object comes back when there is no preset.
 */
export function applyPreset(name, options = {}) {
  if (!name) return options;
  const defaults = presetDefaults(name);
  const merged = { ...options };
  for (const [k, v] of Object.entries(defaults)) {
    if (k === 'footerFromTitle') {
      // resolve only when the user has not named a footer themselves
      merged.footerFromTitle = merged.footerFromTitle ?? merged.pageFooter ?? v;
    } else {
      merged[k] = merged[k] ?? v;
    }
  }
  return merged;
}
