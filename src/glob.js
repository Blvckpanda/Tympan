/**
 * glob.js — zero-dependency glob expansion for CLI inputs.
 *
 * tympan converts what the shell hands it, but Windows shells (and quoted
 * arguments anywhere) pass patterns through unexpanded, so `tympan "docs/*.html"`
 * would be looked up as a literal filename. Expansion lives here — ahead of the
 * pipeline — and stays dependency-free: `*` and `?` per path segment, `[abc]` /
 * `[!abc]` classes, and `**` for any number of segments (including none, so
 * `docs/**\/*.html` matches `docs/a.html`).
 *
 * Semantics, chosen to match the shell so nothing surprises:
 *   - case-sensitive matching;
 *   - `/` and `\` both separate segments on input, `/` is used internally;
 *   - symlinked files are listed, symlinked directories are not followed
 *     (cycle safety);
 *   - results are sorted, so a batch order never depends on readdir();
 *   - a pattern matching nothing is reported by name, never silently dropped.
 */
import fs from 'node:fs';
import path from 'node:path';

/** True when the argument is a pattern rather than a literal path. */
export function isGlobPattern(value) {
  return typeof value === 'string' && /[*?\[]/.test(value);
}

/**
 * A URL input (http://…, https://…, file://…). Never a path and never a
 * pattern: it must reach the pipeline verbatim — `path.resolve` would turn it
 * into `…/http:/host/doc.html`, and a query string's `?` would read as wildcard.
 */
export function isUrlInput(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

const compiled = new Map();

/** Compile one pattern segment (`*`, `?`, `[...]`, literals) to a RegExp. */
function segmentRegExp(segment) {
  let hit = compiled.get(segment);
  if (hit) return hit;
  let src = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '*') {
      src += '[^/]*';
    } else if (ch === '?') {
      src += '[^/]';
    } else if (ch === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close === -1) {
        src += '\\[';
      } else {
        // `[!abc]` is the shell's negated class; JS wants `[^abc]`.
        let body = segment.slice(i + 1, close);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        src += '[' + body.replace(/[\\\]]/g, '\\$&') + ']';
        i = close;
      }
    } else {
      src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  hit = new RegExp('^' + src + '$');
  compiled.set(segment, hit);
  return hit;
}

/** `**` swallows zero or more segments; everything else is segment-exact. */
function matchSegments(patternSegs, pathSegs) {
  if (patternSegs.length === 0) return pathSegs.length === 0;
  const [head, ...rest] = patternSegs;
  if (head === '**') {
    for (let i = 0; i <= pathSegs.length; i++) {
      if (matchSegments(rest, pathSegs.slice(i))) return true;
    }
    return false;
  }
  if (pathSegs.length === 0) return false;
  if (!segmentRegExp(head).test(pathSegs[0])) return false;
  return matchSegments(rest, pathSegs.slice(1));
}

const split = (p) => String(p).replace(/\\/g, '/').split('/');

/**
 * Match a glob pattern against a path (both may use either separator).
 * Pure — exported for tests and for callers that already have the file list.
 * @param {string} pattern
 * @param {string} candidate
 * @returns {boolean}
 */
export function matchGlob(pattern, candidate) {
  return matchSegments(split(pattern), split(candidate));
}

/** Depth-first file listing; returns `/`-joined paths relative to `dir`. */
function walkFiles(dir, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(abs, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    } else if (entry.isSymbolicLink()) {
      try {
        if (fs.statSync(abs).isFile()) out.push(rel);
      } catch {
        /* dangling link — not an input */
      }
    }
  }
  return out;
}

/**
 * Expand one pattern against the filesystem.
 * @param {string} pattern glob pattern (`*`, `?`, `[...]`, `**`)
 * @param {string} [cwd]
 * @returns {string[]} absolute file paths, sorted; `[]` when nothing matches
 */
export function expandGlob(pattern, cwd = process.cwd()) {
  const segs = split(pattern);
  let i = 0;
  while (i < segs.length && !isGlobPattern(segs[i])) i++;
  const base = segs.slice(0, i).join('/') || '.';
  const rest = segs.slice(i);
  const baseAbs = path.resolve(cwd, base);
  const matched = [];
  for (const rel of walkFiles(baseAbs)) {
    if (matchSegments(rest, rel.split('/'))) matched.push(path.join(baseAbs, ...rel.split('/')));
  }
  return matched.sort();
}

/**
 * Expand a positional input list: URLs pass through verbatim, literal paths
 * are resolved (so the caller's own "input not found" error still fires for
 * them), globs expand in place. Duplicates collapse — one input, one run.
 * @param {string[]} args positional arguments, in order
 * @param {object} [options] { cwd }
 * @returns {{inputs: string[], unmatched: string[]}}
 */
export function expandInputs(args, { cwd = process.cwd() } = {}) {
  const inputs = [];
  const unmatched = [];
  const seen = new Set();
  const push = (input) => {
    // Windows paths compare case-insensitively; URLs do not (their path is
    // case-sensitive), so only paths are folded.
    const fold = process.platform === 'win32' && !isUrlInput(input);
    const key = fold ? input.toLowerCase() : input;
    if (seen.has(key)) return;
    seen.add(key);
    inputs.push(input);
  };
  for (const arg of args) {
    if (isUrlInput(arg)) {
      push(arg);
      continue;
    }
    if (!isGlobPattern(arg)) {
      push(path.resolve(cwd, arg));
      continue;
    }
    const hits = expandGlob(arg, cwd);
    if (hits.length === 0) unmatched.push(arg);
    else hits.forEach(push);
  }
  return { inputs, unmatched };
}
