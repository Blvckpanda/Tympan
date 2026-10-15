/**
 * index.js — public library entry point.
 *
 * @example
 *   import { convert } from 'tympan';
 *   const { master, email, detection, verification } = await convert('deck.html', {
 *     email: true,
 *     probe: /www\.example\.city/,
 *     onProgress: (event, data) => console.log(event, data),
 *   });
 *
 * @example
 *   // Batch: one warm browser for many inputs.
 *   import { convertMany } from 'tympan';
 *   const { ok, entries } = await convertMany(['a.html', 'b.html'], {
 *     perInput: (input) => ({ out: `dist/${input.replace(/\.html$/, '')}.pdf` }),
 *   });
 */
export {
  convert,
  convertMany,
  resolveGeometry,
  resolveOutputs,
  PAGE_GEOMETRY,
  DEFAULT_MARGINS,
  cssColorToRgb,
} from './pipeline.js';
export { detectSectionsInPage, capturePreludeInPage, withPrelude, describeDetection } from './detect.js';
export { findChromium, launchOptions } from './browser.js';
export { downscaleImagesInPage, mergeFooter } from './email.js';
export { verifyOutputs, extractPages, probeRegex } from './verify.js';
export { isPrivateTarget, armRequestPolicy } from './security.js';
export { measurePageBackgroundAndWidth, buildCleanTemplate, clampLoadWidth } from './template.js';
export { enginePin, doctorChecks, summarizeDoctor, runDoctor, formatDoctorReport } from './doctor.js';
export { buildJsonReport, buildBatchJsonReport } from './report.js';
export { isGlobPattern, isUrlInput, matchGlob, expandGlob, expandInputs } from './glob.js';
export { parseArgv } from './argv.js';
export {
  goldenTest,
  formatGoldenReport,
  compareFingerprints,
  fingerprintSize,
  goldenSlug,
  goldenPageName,
  FINGERPRINT_WIDTH,
  CELL_THRESHOLD,
  DEFAULT_TOLERANCE,
} from './golden.js';

/** Re-exported orchestrator as the default export for convenience. */
export { convert as default } from './pipeline.js';
