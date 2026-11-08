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
| **Auth** | per-tenant API keys (timing-safe, sha256 at rest); with `--state-dir` the store is persistent and revocation is live; empty key store = no access | a database with audit trails and per-key scopes and expiry |
| **Isolation** | a key sees only its own jobs (404, not 403, for someone else's id) | — |
| **Queue** | bounded FIFO, worker pool, `concurrency` jobs in flight, per-tenant ceiling; with `--state-dir` a journal re-queues incomplete work on restart (at-least-once) | an external broker with cross-machine scheduling |
| **Results** | PDFs + submitted HTML in a temp dir, deleted with the job; with `--state-dir` they live under `payloads/` and survive the process | object storage with lifecycle rules |
| **Retention** | TTL (default 15 min) swept by a timer; `DELETE /v1/jobs/:id` releases early; the journal row is dropped with the bytes | configurable per plan, audited |
| **Quota/billing** | a per-tenant job ceiling, plus a per-tenant meter (submitted/succeeded/failed, pages, bytes, convert ms) counted always, persisted with `--state-dir`, reported on `/v1/me` | plans, invoices, fair-share scheduling |
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

## Durable mode: `--state-dir`

Opt-in, because a CLI server that creates directories the operator did not name
is worse than a spike. With `--state-dir <dir>` (env `TYMPAN_SERVE_STATE_DIR`)
the dir holds exactly four kinds of thing, every write atomic (`.tmp` + rename):

```
<state-dir>/tenants.json   sha256 digests + tenant names — never a plaintext key
<state-dir>/jobs/<id>.json one journal row per accepted job; no payload, no paths
<state-dir>/payloads/      submitted HTML and finished PDFs (<id>.html, <id>.pdf)
<state-dir>/meter.json     per-tenant counters, rewritten on every job finish
```

```bash
tympan serve --state-dir /var/lib/tympan
tympan serve keys add key_live_abc:acme --state-dir /var/lib/tympan
tympan serve keys list --state-dir /var/lib/tympan
tympan serve keys revoke 3f9a1c2d --state-dir /var/lib/tympan   # hash prefix works
```

**Restart semantics, stated rather than implied.** On boot the journal is read
and every `queued` or `running` row is re-queued: a job accepted but not
finished by the previous process is converted by this one — at-least-once. A
`running` row is re-run because a killed conversion has no trustworthy partial
output. If a row's HTML payload or PDF is not on disk, the job becomes `failed`
with that reason (`payload lost on restart` / `result lost on restart`) rather
than hanging or 500ing later. `TYMPAN_KEYS` keys are persisted (hashed) at
start, so both sources authorize; the store is re-read per request, so a
revocation refuses the very next call. The meter is the record, not the
response: `DELETE` releases bytes without rewriting accounting, and the TTL
sweep drops journal rows like it drops PDFs.

**The shapes deliberately not chosen** (recorded in SPEC §6): a database, an
external broker, object storage — each is a component to operate, and none is
what this tier is for. A directory of small JSON files is the whole durability
story, and it needs no dependency the project does not already ship.

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
| `TYMPAN_SERVE_STATE_DIR` | opt-in durable state dir (`--state-dir` overrides); absent = pure spike, nothing written |
| `TYMPAN_CHROMIUM` | path to a Chrome/Chromium executable (else the Playwright cache) |

## What a paid tier would need before charging anyone

1. ~~Keys hashed at rest with rotation and revocation~~ — shipped at file
   level (`tenants.json`, `serve keys`); the database and per-key scopes are
   still ahead.
2. ~~A queue a restart does not lose~~ — shipped as an at-least-once journal
   (`jobs/`); object storage for results is still ahead.
3. ~~Metering per tenant~~ — shipped (jobs by outcome, pages, bytes, convert
   ms, on `/v1/me`); plans and invoices are still ahead.
4. Per-tenant rate limits and a fair-share scheduler, so one tenant cannot
   starve another (today: FIFO and a per-tenant ceiling).
5. Request logs with tenant attribution and retention, and an abuse path for a
   tenant submitting hostile HTML or URLs.
6. A pricing question answered with the corpus numbers (`docs/BENCHMARKS.md`):
   what a page costs in CPU time and bytes, measured, not guessed.
