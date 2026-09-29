/**
 * browser.js — Chromium discovery for tympan.
 *
 * Resolution order:
 *   1. explicit override in options (testability)
 *   2. TYMPAN_CHROMIUM environment variable
 *   3. Playwright-managed browser cache (newest chromium-* build), scanned for
 *      a real chrome executable on Windows / macOS / Linux
 *   4. null — callers surface a clear "run npx playwright install chromium"
 *      error rather than a cryptic launch failure
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXECUTABLE_CANDIDATES = [
  // Windows
  ['chrome-win64', 'chrome.exe'],
  ['chrome-win', 'chrome.exe'],
  // macOS (newer Playwright builds use chrome-mac64)
  ['chrome-mac64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  // Linux (newer Playwright: chrome-linux64 "Chrome for Testing" layout;
  // older builds: chrome-linux)
  ['chrome-linux64', 'chrome'],
  ['chrome-linux', 'chrome'],
];

/**
 * Return the newest chromium-* build directory under a Playwright cache root,
 * or null when the root does not exist.
 */
export function newestChromiumBuild(root) {
  if (!fs.existsSync(root)) return null;
  const builds = fs
    .readdirSync(root)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return builds.length ? path.join(root, builds[0]) : null;
}

function chromeExecutableUnder(buildDir) {
  for (const candidate of EXECUTABLE_CANDIDATES) {
    const exe = path.join(buildDir, ...candidate);
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

function cacheRoots() {
  const home = os.homedir();
  const roots = [];
  if (process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
  }
  roots.push(path.join(home, 'AppData', 'Local', 'ms-playwright')); // Windows
  roots.push(path.join(home, 'Library', 'Caches', 'ms-playwright')); // macOS
  roots.push(path.join(home, '.cache', 'ms-playwright')); // Linux
  return roots;
}

/**
 * Locate a Chromium executable for `chromium.launch({ executablePath })`.
 * @param {{ executablePath?: string }} [options]
 * @returns {string|null} absolute path, or null when nothing usable was found
 */
export function findChromium(options = {}) {
  const explicit = options.executablePath || process.env.TYMPAN_CHROMIUM;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`TYMPAN_CHROMIUM points to a missing file: ${explicit}`);
    }
    return explicit;
  }
  for (const root of cacheRoots()) {
    const build = newestChromiumBuild(root);
    if (!build) continue;
    const exe = chromeExecutableUnder(build);
    if (exe) return exe;
  }
  return null;
}

/** Standard launch options used across the pipeline (one place to tweak). */
export function launchOptions(options = {}) {
  const exe = findChromium(options);
  if (!exe) {
    throw new Error(
      'Chromium not found. Run `npx playwright install chromium`, or point TYMPAN_CHROMIUM at a chrome executable.'
    );
  }
  return {
    executablePath: exe,
    headless: true,
    args: ['--hide-scrollbars'],
  };
}
