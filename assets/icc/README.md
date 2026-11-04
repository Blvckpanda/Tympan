# `sRGB-v2-micro.icc` — provenance

`sRGB-v2-micro.icc` (456 bytes, ICC v2.1, monitor-class, RGB color space) is the
sRGB characterization profile `--pdfa` embeds as the document's OutputIntent
(`/DestOutputProfile`), so a PDF/A validator can confirm DeviceRGB page content
is bound to a real, calibrated color space.

- **Source:** [saucecontrol/Compact-ICC-Profiles](https://github.com/saucecontrol/Compact-ICC-Profiles), file `profiles/sRGB-v2-micro.icc`.
- **License:** [CC0 1.0 Universal](LICENSE) (public domain dedication, copied beside this file) — no obligation, everything else about tympan remains MIT.
- **Fetched:** 2026-11-04, from the upstream `master` archive; sha256 prefix `0a8a33aea66a6f15`.
- **Why this one:** it carries the profile's required tags, the real sRGB
  primaries/TRC values, and nothing else — 456 bytes inflates the repo and every
  PDF by less than half a kilobyte. It is NOT synthesized in code: an sRGB claim
  means a measured characterization, and this profile is one.
- **Why a file and not an npm dependency:** the mission constraint was zero new
  dependencies. A 456-byte CC0 blob is the dependency-free way to carry measured
  data; byte-exact file, same optimized-by-CI size.

If you replace it, keep the symlinks/serialization deterministic: the profile
bytes embed verbatim into every `--pdfa` print, so changing the file changes
every output's digest.
