# Publishing tympan to npm

Publishing is automated: pushing a version tag (`v*`) triggers
[.github/workflows/release.yml](.github/workflows/release.yml), which packs,
publishes with [provenance](https://docs.npmjs.com/generating-provenance), and
creates a GitHub Release with the tarball.

**Current state: migrating to trusted publishing (no `NPM_TOKEN`).** The
workflow's publish step runs unconditionally (the old
`if: env.NPM_TOKEN != ''` guard is gone — with the secret deleted, a guard
would silently *skip* publishing while the job stayed green). v0.4.1 is
the name-migration release and still carries the token as a fallback;
from v0.4.2 the repository has **no npm token secret at all** — the
workflow authenticates with [trusted
publishing](https://docs.npmjs.com/trusted-publishers) (OIDC from GitHub
Actions) and provenance is generated automatically. Requirements, all
satisfied: npm CLI ≥ 11.5.1 on the runner (setup-node 22 provides it) and
`id-token: write` in the workflow.

## One-time setup (done 2026-09-29, kept for reference)

1. **First publish needs the package to exist.** v0.4.0 was published the
   old way (a granular token with **bypass 2FA** enabled — without that
   flag npm rejects with `EOTP`; the toggle only exists at token-creation
   time) plus the `NPM_TOKEN` repository secret.
2. **Add the trusted publisher** on npmjs.com — no API for this, web only:
   * npmjs.com → *Packages* → `@blvckpanda/tympan` → *Settings* →
     **Trusted publisher** → *Connect a publisher* → **GitHub Actions**.
   * Organization/user: `Blvckpanda` · Repository: `Tympan` ·
     Workflow filename: `release.yml` · Environment: leave empty.
   * Save. From now on, that exact workflow can publish without any token.
3. **Delete the token secret** (web UI or API):
   github.com → repo → *Settings* → *Secrets and variables* → *Actions* →
   `NPM_TOKEN` → remove. Also revoke the now-unused token on npmjs.com →
   *Access Tokens*.
4. **Remove the publish guard from the workflow** — with the secret gone,
   an `if: env.NPM_TOKEN != ''` guard would silently *skip* the publish
   step while the job still shows green. The guard must be removed in the
   same commit as the first token-free tag.

## Why the package was scoped, and isn't anymore

npm's typosquat protection rejects new **unscoped** names that are too
similar to existing packages — *at publish time*, even when the name is
unused and resolvable. `aipdf` (too close to `jspdf`) and the short paper
words `ream` and `deckle` were rejected or taken, so the project shipped
scoped (`@blvckpanda/platen`, then `@blvckpanda/tympan`): scoped names
skip the similarity filter entirely and can never be collided. The scope
was a means to a name, not a preference — the spec's actual name, plain
**`tympan`**, was verified free (name + typosquat neighborhood) and
publishes unscoped from v0.4.1. The installed **commands are `tympan` and
`tympan-ui`**. The scoped `@blvckpanda/tympan` stays published as a
historical alias and is deprecated once the unscoped line is proven.

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
3. Watch the run: repo → *Actions* → **Release**. Check the **Publish**
   step's own conclusion (a job can be green while a step was skipped —
   verify per-step in the run's job view).

## Verify the release

```bash
npm view tympan version      # registry has the new version
npm view tympan bin          # tympan + tympan-ui declared
cd "$(mktemp -d)"
npx tympan@latest --help     # installs from the registry and runs
```

(A newly *renamed or created* package can 404 for a few minutes while the
CDN catches up — retry before assuming failure. `tympan-ui` starts a server
and blocks by design; verify it via the bins listing, or `npm run ui` in a
checkout. After a global install both commands are on PATH.)

On npmjs.com → *Packages* → `tympan`, the release page shows the
**Provenance** badge — the public, verifiable link between the published
artifact and this repo's build. Under trusted publishing it appears
automatically.

## Failure modes (all observed at least once)

- **Publish step skipped** — historical (pre-0.4.1): the `NPM_TOKEN` guard.
  The guard is gone; if a future edit re-adds any `if:` on the publish
  step, a missing secret will fail loudly instead (`npm publish` without
  auth errors out) — that is the desired behavior.
- **`EOTP` / "requires a one-time password"** — historical (token era):
  the token lacked the **bypass 2FA** flag. Gone with trusted publishing.
- **`E403` "Package name too similar to existing package"** — the typosquat
  filter rejecting an unscoped name at publish time. Nothing to override:
  fall back to a scoped name (that's why v0.3–v0.4.0 shipped scoped; the
  final unscoped name cleared the filter in 0.4.1).
- **`E403` on the unscoped `tympan` at publish time** — would mean npm's
  similarity filter disagrees with the registry search; the fallback is
  the scoped name. (Did not happen: v0.4.1 published unscoped.)
- **403 on publish under trusted publishing** — the trusted-publisher
  entry doesn't match: repo name, owner, or workflow filename must equal
  the workflow actually running (`release.yml` on `Blvckpanda/Tympan`), or
  the run lacks `id-token: write` / OIDC. Re-check the package's settings
  page and the workflow's `permissions:` block. The entry is per-package:
  when the package name changed, it had to be re-added on the new
  package's settings page.
- **404 right after publish** — CDN lag (see above), not a failure.
- **Provenance error** — requires a public package + OIDC + `repository`
  in `package.json` pointing at the repo the workflow ran in. Keep the
  `repository`/`homepage`/`bugs` fields in sync if the repo ever moves.

## Repo front page (launch checklist)

- **About description + website:** repo → ⚙ next to *About* → description:
  *"Deterministic, secure, fast HTML-to-PDF converter: one section per
  page, self-verifying output, zero flags. CLI + library."* → website:
  `https://www.npmjs.com/package/tympan` → Topics: `pdf`,
  `html`, `converter`, `chromium`, `cli`, `automation`. (Set via API; the
  web path above edits the same fields.)
- **Social preview (web UI only, no API):** repo → *Settings* → *General*
  → **Social preview** → *Edit* → *Upload a new image* → pick
  [assets/social-card.png](assets/social-card.png) (1280×640) → *Save*.
