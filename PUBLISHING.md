# Publishing @blvckpanda/platen to npm

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
   * **Token name**: something identifiable, e.g. `platen_ci_token`.
   * **Expiration**: 90 days (rotate on schedule; npm is tightening
     token-bypass-2FA publishing over 2026–2027 — see the migration note
     below).
   * **Packages and scopes**: **Read and write**.
   * **Package selection**: **All packages** — per-package selection cannot
     authorize a package that doesn't exist yet, and the *first* publish
     creates `@blvckpanda/platen`. After the first release you may rotate to
     a token scoped to just that package.
   * **Enable "bypass 2FA" on the token.** This is the step that breaks CI
     publishes when missed: if the account requires 2FA and the token doesn't
     carry the bypass, npm rejects the publish with `EOTP` ("requires a
     one-time password") no matter how valid the token is. The toggle only
     exists at token-creation time.
   * *Generate Token* → copy the `npm_…` value (shown exactly once).

2. **Give the repo the token as a secret** — via the GitHub web UI
   (the REST API route requires encrypting the secret with libsodium, which
   the web UI does for you):
   * github.com → the repo → *Settings* → *Secrets and variables* → *Actions*
     → **New repository secret**.
   * Name: `NPM_TOKEN` · Value: paste the `npm_…` token → *Add secret*.

## Why the package is scoped (`@blvckpanda/platen`)

npm's typosquat protection rejects new **unscoped** names that are too
similar to existing packages — *at publish time*, even when the name is
unused and resolvable. `aipdf` (too close to `jspdf`) and every short paper
word (`ream`, `deckle`, bare `platen` — squatted) were rejected or taken.
Scoped names skip the similarity filter entirely and can never be collided
or squatted. The `@blvckpanda/` prefix just names the publisher. The
installed **command is still `platen`**.

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
npm view @blvckpanda/platen version      # registry has the new version
npm view @blvckpanda/platen bin          # platen + platen-ui declared
cd "$(mktemp -d)"
npx @blvckpanda/platen --help            # installs from the registry and runs
```

(`platen-ui` starts a server and blocks by design — verify it via the bins
listing above, or `npm run ui` in a checkout. After a global install both
`platen` and `platen-ui` are on PATH.)

On npmjs.com → *Packages* → `@blvckpanda/platen`, the package page should
show the **Provenance** badge on the release — that's the public, verifiable
link between the published artifact and this repo's build.

## Failure modes (all observed at least once)

- **Publish step skipped** — `NPM_TOKEN` secret is missing/unset; add it and
  re-run the workflow from the Actions tab (re-run is safe: npm rejects
  duplicate versions, so a half-published release can't corrupt the registry).
- **`EOTP` / "requires a one-time password"** — the token lacks the
  **bypass 2FA** flag (it can only be set when the token is created). Create
  a new token with the flag on and update the secret; re-run is safe.
- **`E403` "Package name too similar to existing package"** — the typosquat
  filter rejecting an unscoped name at publish time. Nothing to override:
  pick a scoped name (that's why this package is `@blvckpanda/platen`).
- **403 on publish (other)** — token lacks write permission/scopes, doesn't
  cover the package, or expired (granular tokens carry an expiration date).
- **Provenance error** — provenance requires public packages + OIDC; the
  workflow already sets `id-token: write`. It also requires
  `repository` in `package.json` to point at the repo the workflow ran in —
  keep the `repository`/`homepage`/`bugs` fields in sync if the repo moves.

## Migration note: trusted publishing (before Jan 2027)

npm is sunsetting tokens that bypass 2FA for direct publishing (account
changes restricted Aug 2026, direct publishing Jan 2027). The endgame is
[trusted publishing](https://docs.npmjs.com/trusted-publishers/): the
workflow already carries `id-token: write`, so once the package exists, add
a trusted publisher on the package's npm settings page
(user `Blvckpanda`, repo `Platen`, workflow `release.yml`) and the publish
becomes token-free with provenance generated automatically. Then the
`NPM_TOKEN` secret can be revoked and the token class problem disappears.
