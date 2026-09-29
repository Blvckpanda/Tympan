# Publishing aipdf to npm

Publishing is automated: pushing a version tag (`v*`) triggers
[.github/workflows/release.yml](.github/workflows/release.yml), which packs,
publishes with [provenance](https://docs.npmjs.com/generating-provenance), and
creates a GitHub Release with the tarball. Until the `NPM_TOKEN` secret is set,
the workflow runs but **skips the publish step** — the GitHub Release still
happens.

## One-time setup

1. **npm granular access token** — created on the npmjs.com website (no
   terminal login needed):
   * npmjs.com → avatar → *Access Tokens* → *Generate New Token* →
     **Granular Access Token**.
   * **Token name**: something identifiable, e.g. `aipdf_npm_token`.
   * **Expiration**: 90 days (rotate on schedule; npm is tightening
     token-bypass-2FA publishing over 2026–2027, and short-lived granular
     tokens are the compliant pattern).
   * **Packages and scopes**: **Read and write**.
   * **Package selection**: **All packages** — per-package selection cannot
     authorize a package that doesn't exist yet, and the *first* publish
     creates `aipdf`. After the first release you may rotate to a token
     scoped to just the `aipdf` package.
   * *Generate Token* → copy the `npm_…` value (shown exactly once).

2. **Give the repo the token as a secret** — via the GitHub web UI
   (the REST API route requires encrypting the secret with libsodium, which
   the web UI does for you):
   * github.com → the repo → *Settings* → *Secrets and variables* → *Actions*
     → **New repository secret**.
   * Name: `NPM_TOKEN` · Value: paste the `npm_…` token → *Add secret*.

   If the repo doesn't exist yet, create it first
   (github.com → *New repository* → name `aipdf`, public, no auto-generated
   files — the local history is pushed as-is).

3. **Local publishing (fallback only)** — CI with provenance is the normal
   path; if you must publish from a machine:
   ```bash
   # npm login works interactively (browser flow); on a headless box:
   NODE_AUTH_TOKEN=npm_xxx npm publish --access public
   ```
   Plain local publishes cannot carry provenance — provenance requires the
   CI OIDC environment, which is one more reason to prefer the tag workflow.

## Cutting a release

1. Bump the version and update `CHANGELOG.md` first:
   ```bash
   npm version <patch|minor|major>   # updates package.json + creates the tag
   ```
2. Push the branch state and the tag (the tag is what fires the workflow):
   ```bash
   git push origin main --follow-tags
   ```
   **Watch out:** *any* `v*` tag fires the release workflow — never push a
   tag for a version that is already on npm (duplicate versions are rejected
   by the registry) and never push tags you didn't intend to release.
3. Watch the run: repo → *Actions* → **Release**. Publish requires the
   `NPM_TOKEN` secret; without it the step shows as skipped while the GitHub
   Release still lands.

## Verify the release

```bash
npm view aipdf version                 # registry has the new version
npm view aipdf bin                     # both bins (aipdf, aipdf-ui) declared
cd "$(mktemp -d)"
npx aipdf --help                       # installs from the registry and runs
```

(`npx aipdf-ui` starts a server and blocks by design — verify it via the
bins listing above, or by running `npm run ui` in a checkout.)

On npmjs.com → *Packages* → `aipdf`, the package page should show the
**Provenance** badge on the release — that's the public, verifiable link
between the published artifact and this repo's build.

## Failure modes

- **Publish step skipped** — `NPM_TOKEN` secret is missing/unset; add it and
  re-run the workflow from the Actions tab (re-run is safe: npm rejects
  duplicate versions, so a half-published release can't corrupt the registry).
- **403 on publish** — the token lacks write permission for the package, the
  token is scoped to packages that don't include `aipdf`, or the token
  expired (granular tokens carry an expiration date).
- **Provenance error** — provenance requires public packages + OIDC; the
  workflow already sets `id-token: write`. It also requires
  `repository` in `package.json` to point at the repo the workflow ran in —
  keep the `repository`/`homepage`/`bugs` fields in sync if the repo moves.
