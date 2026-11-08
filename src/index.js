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
  measureSections,
  resolveGeometry,
  resolveOutputs,
  PAGE_GEOMETRY,
  DEFAULT_MARGINS,
  cssColorToRgb,
} from './pipeline.js';
export { detectSectionsInPage, capturePreludeInPage, withPrelude, describeDetection } from './detect.js';
export { auditAccessibilityInPage, a11yFindings, CONTRAST_NORMAL, CONTRAST_LARGE } from './a11y.js';
export { auditPdfBytes, classifyStream, formatBytesReport, BYTE_KINDS } from './bytes.js';
export { minifyPdf, OBJSTM_MAX_OBJECTS, OBJSTM_MAX_BYTES, MINIFY_LEVEL } from './minify.js';
export { inspectTagged, applyStandardsTail, buildTaggedXmp, loadSrgbProfile, PDF_UA_VERSION, PDF_A_PART, PDF_A_CONFORMANCE } from './tagged.js';
export { stampPdf, placementFor, fontSizeFor, STAMP_OPACITY } from './stamp.js';
export { splitPdf } from './split.js';
export { findChromium, launchOptions } from './browser.js';
export { downscaleImagesInPage, mergeFooter } from './email.js';
export { verifyOutputs, extractPages, probeRegex } from './verify.js';
export {
  TARGET_FILL,
  fillRatio,
  blankTailPx,
  judgePage,
  summarizeQuality,
  formatQualityLine,
} from './metrics.js';
export {
  SEVERITY_RANK,
  SCALE_WARN,
  SCALE_SPREAD,
  lintDocument,
  summarizeLint,
  failureReport,
  lintExitCode,
  formatLintReport,
  auditSourceInPage,
} from './lint.js';
export { isPrivateTarget, armRequestPolicy } from './security.js';
export { measurePageBackgroundAndWidth, buildCleanTemplate, clampLoadWidth } from './template.js';
export { measureBlockInPage } from './measure.js';
export {
  PREVIEW_DEFAULT_PORT,
  sheetSizePx,
  buildPreviewReport,
  previewPage,
  contentTypeFor,
  createPreviewServer,
} from './preview.js';
export {
  SERVE_DEFAULT_PORT,
  MAX_BODY_BYTES,
  MAX_JOBS_PER_TENANT,
  ALLOWED_JOB_OPTIONS,
  parseApiKeys,
  authorize,
  validateJobRequest,
  publicJob,
  createJobQueue,
  createServeServer,
  servePolicy,
  jobGeometry,
} from './serve.js';
export {
  STATE_VERSION,
  openServeState,
  hashKey,
  keyFingerprint,
  emptyMeterRow,
  meterJobUpdate,
} from './serve-state.js';
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
  diffBands,
  FINGERPRINT_WIDTH,
  DIFF_SCALE,
  DIFF_GAP,
  CELL_THRESHOLD,
  DEFAULT_TOLERANCE,
} from './golden.js';

/** Re-exported orchestrator as the default export for convenience. */
export { convert as default } from './pipeline.js';
