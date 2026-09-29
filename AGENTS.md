# AGENTS.md — working notes for AI agents in this repo

Project: **tympan** — deterministic, secure, fast HTML→PDF converter
(one semantic section per page, runtime print-CSS defeated, self-verifying
output). Package `tympan` on npm, commands `tympan` / `tympan-ui`, repo
`Blvckpanda/Tympan`. The charter is [SPEC.md](SPEC.md) (verbatim product
spec + adoption decisions in §10); history in [CHANGELOG.md](CHANGELOG.md).

## Layout

| Path | Owns |
|---|---|
| `src/pipeline.js` | convert() orchestration, geometry, printSection shrink loop, merge, outline, wait-for |
| `src/template.js` | clean-document builder + background/width measurement (in-page fns: DOM-only, no Node scope) |
| `src/detect.js` | section-detection ladder + prelude capture (in-page) |
| `src/email.js` | image downscale + footer merge |
| `src/security.js` | request gate: file:// + private/metadata blocks, --offline/--allow-net (pure decision fns + Playwright arm helper) |
| `src/verify.js` | output verification + `probeRegex` (probes are case-insensitive, whitespace-flexible, strings match literally) |
| `src/doctor.js` | `tympan doctor`: env/engine checks (pure over injected inputs) |
| `src/report.js` | `--json` report serializer (pure) |
| `src/browser.js` | Chromium discovery (`TYMPAN_CHROMIUM` env override, Playwright cache scan) |
| `src/ui/server.js` + `bin/tympan-ui.js` | zero-dep preview UI (SSE progress, live reload) |
| `bin/tympan.js` | thin CLI wrapper (flags incl. --wait-for/--json; `tympan doctor`) |
| `test/*.test.mjs` | node:test suites; spill pins shrink-to-fit; fidelity pins portrait/bg/determinism/security; phase1 pins waits/doctor/json/file-leak E2E |
| `scripts/smoke-real.mjs` | real-deck acceptance (`TYMPAN_REAL_DECK` / `TYMPAN_REAL_PROBE`) |
| `scripts/capture-assets.mjs` | re-shoots `assets/tympan-ui.png` + `assets/social-card.png` + `assets/demo.gif` (ffmpeg) |
| `scripts/gen-image-fixture.mjs` | test-time photo-like image fixture generator (writes into gitignored test/out/) |

## Non-negotiable rules

- **No SGC/Heri Homes content ever enters this repo** — the Sanctus Gardens
  City / Heri Homes brief (`C:\Users\pc\Downloads\HeriHomes_CreativeBrief_John.html`)
  is a LOCAL-ONLY acceptance deck (it carries the SGC watermark). Outputs of
  `smoke:real` against it go to Downloads, never into the repo; scratch copies
  are deleted after the run.
- **In-page functions** (`detectSectionsInPage`, `capturePreludeInPage`,
  `buildCleanTemplate`, `measurePageBackgroundAndWidth`,
  `detectContentMaxWidthInPage`) are serialized into the browser: no
  Node-scope references, no imports. Playwright `evaluate` takes exactly
  ONE serializable argument — bundle params in an object.
- **Build file:// URLs with `pathToFileURL()`** — never hand-concatenate.
  The hand-built form is `file:////home/...` on POSIX; Chromium normalizes
  it in route handlers but not in your policy strings, so the security
  gate's mainUrl exemption silently misses and CI blocks its own input
  (the v0.5.0 CI failure).
- **Chromium pre-blocks page-initiated file:// subresources** (scheme
  policy) before userland route handlers run — the gate's file:// branch is
  defense-in-depth. Assert the user-facing guarantee (no leak, gate engaged
  for network requests) rather than exact blocked-counts; Chromium also
  retries aborted image requests, so counts can exceed one.
- **Playwright is exact-pinned** (no caret) — a floating engine is a silent
  rendering change. Bump deliberately, run the full gates, note it in the
  CHANGELOG.
- **pdfjs-dist stays at 3.11.174** (newer throws `hashOriginal.toHex` during
  text extraction), loaded via `createRequire` legacy build.
- **Release workflow has no npm secret, by design.** Publishing is npm
  trusted publishing (OIDC); never re-add an `if:` guard or token env to
  the publish step — failures must be loud. See [PUBLISHING.md](PUBLISHING.md)
  for the two failure modes we hit live (runner npm < 11.5.1 → E404;
  stage-only allowed-actions default → "OIDC permission denied").

## Gates before any commit

```bash
node --check <every touched .js/.mjs>
npm test            # 40 tests; browser tests skip without Chromium/network
tympan doctor       # or: node bin/tympan.js doctor  (env/engine check, non-zero on failure)
npm run smoke       # hostile fixture end-to-end, exit code asserted
TYMPAN_REAL_DECK=... TYMPAN_REAL_PROBE=... npm run smoke:real   # optional, real deck
```

CI (`ci.yml`) runs the matrix on Ubuntu; releases fire on `v*` tags
(`release.yml`): npm ci → npm upgrade → pack guard → trusted publish →
GitHub Release with the tarball.

## Environment gotchas (Windows + Git Bash)

- Detached servers: use PowerShell `Start-Process`; nohup hangs. Check
  ports with `netstat -ano | grep :PORT` and kill your own orphans via
  `taskkill //PID <pid> //F` (double slashes in Git Bash).
- Chromium: launch via `findChromium()` from `src/browser.js` with
  `executablePath` (bundled-revision mismatch otherwise).
- Heredocs strip backslashes; write JS fixtures with `printf` or files.
- npm CDN lags minutes behind a fresh publish — poll with cache-busting
  before assuming a release failed; `npm cache clean --force` if the local
  cache serves a stale packument.

## Releasing

Bump `package.json` + CHANGELOG → commit → push → tag `v*` → push tag →
poll the run's per-step conclusions (a green job can hide a failed step —
read the steps, or the logs). Verify: `npm view tympan version`, then a
clean-dir `npx -y tympan@latest deck.html --probe ...`. Full playbook in
[PUBLISHING.md](PUBLISHING.md).
