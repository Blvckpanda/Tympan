# `tympan serve` — the hosted slice

An HTTP API in front of the same converter the CLI runs. It exists to answer one
question honestly: **what would a hosted tympan actually be, and which parts are
real today?**

```bash
TYMPAN_KEYS="key_live_abc:acme,key_test_xyz:demo" tympan serve --port 8080
# tympan serve: http://127.0.0.1:8080 - 2 tenant key(s), concurrency 2, retention 15 min
```

## What is real, and what is a spike

| | today | before this is a product |
|---|---|---|
| **Auth** | per-tenant API keys from `TYMPAN_KEYS`, timing-safe compare, empty key store = no access | keys hashed at rest, in a database, with rotation and revocation |
| **Isolation** | a key sees only its own jobs (404, not 403, for someone else's id) | — |
| **Queue** | bounded FIFO, worker pool, `concurrency` jobs in flight, per-tenant ceiling | a durable broker: a restart currently loses queued work |
| **Results** | PDFs + submitted HTML in a temp dir, deleted with the job | object storage with lifecycle rules |
| **Retention** | TTL (default 15 min) swept by a timer; `DELETE /v1/jobs/:id` releases early | configurable per plan, audited |
| **Quota/billing** | a per-tenant job ceiling only | metering, plans, invoices |
| **Observability** | `/healthz`, one log line per start | request logs, metrics, traces |

It is a spike with production-shaped seams, and the seams are the part worth
reviewing: they are where a paid tier's hard questions live.

## The two decisions that make it an API and not an SSRF proxy

1. **A caller sends `html` or `url`. Never a path.** The CLI converts local files
   because a human chose them; an API that accepted paths would let any key read
   the server's filesystem. A `path` or `file` field is refused *by name*, with
   the reason, before the generic unknown-field check.
2. **Network policy belongs to the server.** `offline` and `allowNet` are dropped
   from a submitted job, not honoured, and the default gate still refuses
   `file://` reads and private/metadata IP ranges. If a tenant could set them,
   a tenant could point the converter at the host's internal network.

Both are pinned by tests (`test/serve.test.mjs`), including the negative: a job
submitted with `options.allowNet = ['*']` reaches the converter with no
`allowNet` at all.

## API

| route | auth | what |
|---|---|---|
| `GET /healthz` | no | `{ ok, queued, active, jobs }` — for a load balancer |
| `GET /v1/me` | yes | tenant, live job count, ceiling, concurrency, retention |
| `POST /v1/jobs` | yes | `{ html \| url, options? }` → `202 { id, status, ... }` |
| `GET /v1/jobs/:id` | yes | status, report (pages, bytes, fill line), `pdfUrl` |
| `GET /v1/jobs/:id/pdf` | yes | the PDF (`application/pdf`), or `409` while not done |
| `DELETE /v1/jobs/:id` | yes | release the job and its bytes early |

`options` may set design values only: `selector`, `format`, `orientation`,
`margins`, `contentWidth`, `background`, `probe`, `outline`, `title`, `author`,
`subject`, `teaser`, `waitFor`, `waitTimeout`, `targetFill`. Anything else is
dropped. `contentWidth` can narrow the layout but is capped at the printable
column, so a tenant cannot ask for a page Chromium would have to scale down.

Status codes: `400` bad request (including "never a server file path"), `401`
missing/invalid key, `404` unknown route or another tenant's job, `405` wrong
method, `409` PDF requested before the job is done, `413` body over the limit
(2 MB), `429` tenant over its job ceiling, `503` the queue is full.

A job that converts but fails its own verification is reported **failed**: the
contract is a verified PDF, not merely a PDF.

## Docker

```bash
docker build -t tympan .
docker run --rm -p 8080:8080 -e TYMPAN_KEYS="key_live_abc:acme" tympan
```

The image is based on the Playwright image **at the exact version pinned in
`package.json`** (`1.63.0`): the promise is reproducible bytes, so the container
that runs the engine is pinned to the same release. It runs as the image's
non-root user, ships no source map and no dev dependency, and its healthcheck
calls `/healthz`.

Two deployment notes. Chromium may need sandbox configuration in some container
runtimes — set `TYMPAN_CHROMIUM` to a system Chrome, or configure the runtime,
rather than shipping `--no-sandbox` to everyone. And put a reverse proxy in front
for TLS, connection limits and request logging; the body cap here is a
correctness guard, not a substitute for one.

## Environment

| variable | meaning |
|---|---|
| `TYMPAN_KEYS` | `key:tenant` pairs, comma separated. Required; no keys means no access |
| `TYMPAN_SERVE_CONCURRENCY` | jobs in flight (default 2; `--concurrency` overrides) |
| `TYMPAN_CHROMIUM` | path to a Chrome/Chromium executable (else the Playwright cache) |

## What a paid tier would need before charging anyone

1. Keys in a database, hashed, with rotation and per-key scopes.
2. A durable queue and object storage, so a restart is not data loss.
3. Metering per tenant (pages rendered, CPU seconds), then plans and invoices.
4. Per-tenant rate limits and a fair-share scheduler, so one tenant cannot
   starve another.
5. Request logs with tenant attribution and retention, and an abuse path for a
   tenant submitting hostile HTML or URLs.
6. A pricing question answered with the corpus numbers (`docs/BENCHMARKS.md`):
   what a page costs in CPU time and bytes, measured, not guessed.
