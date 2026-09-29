/**
 * doctor.js — `tympan doctor`: environment and engine checks.
 *
 * The checks are pure functions over injected inputs (unit-testable without
 * a browser); runDoctor() gathers the real data. Required checks failing
 * means tympan cannot produce correct output — doctor exits non-zero so CI
 * and setup scripts can gate on it. ffmpeg is informational (only the
 * asset/demo-GIF script uses it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * The engine contract: the exact-pinned playwright version from this
 * checkout's package.json (no caret/tilde) — a floating engine is a
 * silent rendering change.
 * @returns {{pinned: string|null, installed: string|null, exact: boolean}}
 */
export function enginePin() {
  let pinned = null;
  try {
    const pkg = require('../package.json');
    pinned = (pkg.dependencies && pkg.dependencies.playwright) || null;
  } catch { /* not in a checkout */ }
  const exact = !!pinned && !/^[\^~]/.test(pinned);
  let installed = null;
  try {
    installed = require('playwright/package.json').version;
  } catch { /* playwright not resolvable */ }
  return { pinned, installed, exact };
}

/**
 * Evaluate the doctor checks over gathered inputs.
 * @param {object} env {nodeVersion, engine:{pinned,installed,exact},
 *   chromiumPath, ffmpegPath}
 * @returns {Array<{name, ok, required, detail}>}
 */
export function doctorChecks(env) {
  const checks = [];
  const nodeMajor = parseInt(String(env.nodeVersion || '').replace(/^v/, '').split('.')[0], 10);
  checks.push({
    name: 'node',
    ok: Number.isFinite(nodeMajor) && nodeMajor >= 20,
    required: true,
    detail: env.nodeVersion || 'unknown',
  });
  const e = env.engine || {};
  const pinOk = !!e.pinned && e.exact;
  const matchOk = !!e.pinned && e.pinned === e.installed;
  checks.push({
    name: 'playwright pin',
    ok: pinOk,
    required: true,
    detail: pinOk ? `${e.pinned} (exact)` : `${e.pinned || 'missing'} must be exact-pinned (no ^/~)`,
  });
  checks.push({
    name: 'playwright installed',
    ok: matchOk,
    required: true,
    detail: e.installed ? `v${e.installed} ${matchOk ? '=== pin' : '!== pin ' + e.pinned}` : 'not resolvable — run npm install',
  });
  checks.push({
    name: 'chromium',
    ok: !!env.chromiumPath,
    required: true,
    detail: env.chromiumPath || 'not found — run npx playwright install chromium (or set TYMPAN_CHROMIUM)',
  });
  checks.push({
    name: 'ffmpeg (demo GIF)',
    ok: !!env.ffmpegPath,
    required: false,
    detail: env.ffmpegPath ? 'on PATH' : 'not on PATH — scripts/capture-assets.mjs will skip demo.gif',
  });
  return checks;
}

/** A check fails the doctor run only if it is required. */
export function summarizeDoctor(checks) {
  const failed = checks.filter((c) => c.required && !c.ok);
  return { ok: failed.length === 0, failed: failed.length };
}

/**
 * Gather real environment data and run the checks.
 * @returns {{checks, summary, nodeVersion}}
 */
export function runDoctor() {
  const { findChromium } = require('./browser.js');
  const chromiumPath = findChromium();
  const ff = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  const env = {
    nodeVersion: process.version,
    engine: enginePin(),
    chromiumPath,
    ffmpegPath: ff.status === 0,
  };
  const checks = doctorChecks(env);
  return { checks, summary: summarizeDoctor(checks), nodeVersion: process.version };
}

/** Human-readable doctor report (each check on one line). */
export function formatDoctorReport({ checks, summary }) {
  const lines = checks.map((c) => {
    const mark = c.ok ? '[ok]' : (c.required ? '[FAIL]' : '[warn]');
    return `${mark} ${c.name.padEnd(20)} ${c.detail}`;
  });
  lines.push(summary.ok ? 'doctor: environment ready' : `doctor: ${summary.failed} required check(s) failed`);
  return lines.join('\n');
}
