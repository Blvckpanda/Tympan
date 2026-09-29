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
 */
export { convert, resolveGeometry, PAGE_GEOMETRY, DEFAULT_MARGINS, cssColorToRgb } from './pipeline.js';
export { detectSectionsInPage, capturePreludeInPage, withPrelude, describeDetection } from './detect.js';
export { findChromium, launchOptions } from './browser.js';
export { downscaleImagesInPage, mergeFooter } from './email.js';
export { verifyOutputs } from './verify.js';
export { isPrivateTarget, armRequestPolicy } from './security.js';
export { measurePageBackgroundAndWidth, buildCleanTemplate, clampLoadWidth } from './template.js';

/** Re-exported orchestrator as the default export for convenience. */
export { convert as default } from './pipeline.js';
