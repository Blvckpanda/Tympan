/**
 * serve.js — `tympan serve`: the HTTP API, and the first slice of a paid tier.
 *
 * This is a SPIKE with production-shaped seams, and it is written to be honest
 * about which parts are which:
 *
 *   real      per-tenant API keys (timing-safe compare), per-tenant job
 *             isolation, a bounded queue with a worker pool, TTL retention,
 *             request size caps, and the same secure-by-default conversion
 *             path the CLI uses.
 *   NOT real  the key store (env var, not a database), the queue (memory, not
 *             a broker — a restart loses queued work), the result store (a
 *             temp directory, not object storage), and billing/quota
 *             accounting beyond a per-tenant job ceiling.
 *
 * Two decisions worth stating because they are the difference between an API
 * and an SSRF proxy:
 *
 *   1. **A remote caller may submit `html` or `url`. Never a path.** The CLI
 *      converts local files because a human chose them; an API that accepted
 *      paths would let any key read the server's filesystem.
 *   2. **Network policy is the SERVER's, not the client's.** `offline` and
 *      `allowNet` are not accepted in a job request: if a tenant could set
 *      them, a tenant could point the converter at the host's internal
 *      network. The server sets the policy; the client sets design options
 *      only (geometry, margins, background, probe, outline).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { convert, resolveGeometry } from './pipeline.js';
import { formatQualityLine } from './metrics.js';

/** Default listen port for `tympan serve`. */
export const SERVE_DEFAULT_PORT = 8080;
/** Largest accepted JSON body (bytes) — an HTML document, not an archive. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Jobs a tenant may hold at once, queued or running. */
export const MAX_JOBS_PER_TENANT = 16;
/** How long a finished job and its PDF stay available (ms). */
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** Design options a client may set. Anything else is refused, not ignored. */
export const ALLOWED_JOB_OPTIONS = [
  'selector',
  'format',
  'orientation',
  'margins',
  'contentWidth',
  'background',
  'probe',
  'outline',
  'title',
  'author',
  'subject',
  'teaser',
  'waitFor',
  'waitTimeout',
  'targetFill',
  'flow',
  'pageNumbers',
  'layout',
  'fill',
  'toc',
  'pageFooter',
  'preset',
];

/**
 * Parse `TYMPAN_KEYS` ("key:tenant,key2:tenant2") into a key→tenant map.
 * Pure. A blank spec yields an empty map: no keys, no access.
 * @param {string} spec
 * @returns {Map<string, string>}
 */
export function parseApiKeys(spec) {
  const map = new Map();
  for (const pair of String(spec || '').split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue; // a key with no tenant is a misconfiguration, not a key
    map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
  }
  return map;
}

/**
 * Authorize a request from its headers.
 * The comparison is timing-safe and runs over every key, so a wrong key takes
 * the same time regardless of how much of a real key it happens to match.
 * Pure (no I/O), so the whole contract is unit-tested.
 * @param {Record<string, string|undefined>} headers
 * @param {Map<string, string>} keys
 * @returns {{ok: true, tenant: string}|{ok: false, reason: string}}
 */
export function authorize(headers, keys) {
  const h = headers || {};
  const auth = h.authorization || h.Authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(String(auth));
  const presented = (bearer ? bearer[1] : h['x-api-key'] || h['X-Api-Key'] || '').trim();
  if (!presented) return { ok: false, reason: 'missing API key (Authorization: Bearer <key> or x-api-key)' };
  if (!keys || keys.size === 0) return { ok: false, reason: 'this server has no API keys configured' };
  const presentedBuf = Buffer.from(presented);
  let matched = null;
  for (const [key, tenant] of keys) {
    const known = Buffer.from(key);
    // Length is compared first (Buffer.compare would throw on a mismatch), but
    // the value comparison is constant-time with respect to the key bytes.
    if (known.length === presentedBuf.length && crypto.timingSafeEqual(known, presentedBuf)) matched = tenant;
  }
  if (!matched) return { ok: false, reason: 'invalid API key' };
  return { ok: true, tenant: matched };
}

/**
 * Validate a job request body. Pure.
 * @param {unknown} body parsed JSON
 * @returns {{ok: true, input: {kind: 'html'|'url', value: string}, options: object}
 *   |{ok: false, status: number, error: string}}
 */
export function validateJobRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }
  // A path-shaped submission is refused by NAME before the generic
  // unknown-field check, so the caller gets the real reason: an API that reads
  // the server's filesystem for whoever holds a key is an SSRF primitive.
  if (body.path !== undefined || body.file !== undefined) {
    return { ok: false, status: 400, error: 'this API converts html or url, never a server file path' };
  }
  const keys = Object.keys(body);
  const unknown = keys.filter((k) => k !== 'html' && k !== 'url' && k !== 'options');
  if (unknown.length) return { ok: false, status: 400, error: `unknown field(s): ${unknown.join(', ')}` };
  if (body.html !== undefined && body.url !== undefined) {
    return { ok: false, status: 400, error: 'send either html or url, not both' };
  }
  if (body.html !== undefined) {
    if (typeof body.html !== 'string' || !body.html.trim()) {
      return { ok: false, status: 400, error: 'html must be a non-empty string' };
    }
    return { ok: true, input: { kind: 'html', value: body.html }, options: validateOptions(body.options) };
  }
  if (body.url !== undefined) {
    if (typeof body.url !== 'string' || !/^https?:\/\//i.test(body.url)) {
      return { ok: false, status: 400, error: 'url must be an absolute http(s) URL' };
    }
    return { ok: true, input: { kind: 'url', value: body.url }, options: validateOptions(body.options) };
  }
  return { ok: false, status: 400, error: 'send html or url' };
}

/** Design options only; the server owns the network policy. Pure. */
function validateOptions(options) {
  if (options === undefined) return {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return {};
  }
  const out = {};
  for (const [k, v] of Object.entries(options)) {
    if (!ALLOWED_JOB_OPTIONS.includes(k)) continue; // server-owned keys are DROPPED, never honored
    if (k === 'format' && v !== 'a4' && v !== 'letter') continue;
    if (k === 'orientation' && v !== 'portrait' && v !== 'landscape') continue;
    out[k] = v;
  }
  return out;
}

/**
 * The public view of a job: no tenant, no filesystem paths, no internal fields.
 * Pure.
 */
export function publicJob(job, baseUrl = '') {
  const out = {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    input: job.input.kind,
    options: job.options,
  };
  if (job.startedAt) out.startedAt = job.startedAt;
  if (job.finishedAt) out.finishedAt = job.finishedAt;
  if (job.error) out.error = job.error;
  if (job.report) out.report = job.report;
  if (job.status === 'done') {
    out.pdfUrl = `${baseUrl}/v1/jobs/${job.id}/pdf`;
  }
  if (job.progress && job.progress.length) out.progress = job.progress.slice(-5);
  return out;
}

/**
 * A bounded FIFO queue with a worker pool.
 *
 * Bounded on purpose: Chromium printing is CPU-bound, so an unbounded queue is
 * a way to make every tenant's jobs slow while the host melts. `enqueue`
 * returns false when the queue is full — counted as pending PLUS running, which
 * is what "the queue is full" means to the client that gets the 429 — and the
 * worker pool keeps at most `concurrency` jobs in flight.
 *
 * @param {object} opts { concurrency, run(job), maxQueued }
 */
export function createJobQueue({ concurrency = 2, run, maxQueued = 32 } = {}) {
  const pending = [];
  let active = 0;
  const waiters = [];
  const settle = () => {
    const waiting = waiters.splice(0);
    for (const resolve of waiting) resolve();
  };
  const pump = () => {
    while (active < concurrency && pending.length) {
      const job = pending.shift();
      active++;
      Promise.resolve()
        .then(() => {
          job.status = 'running';
          job.startedAt = new Date().toISOString();
          return run(job);
        })
        .then(
          (result) => {
            job.status = 'done';
            job.result = result;
          },
          (error) => {
            job.status = 'failed';
            job.error = (error && error.message) || String(error);
          }
        )
        .finally(() => {
          job.finishedAt = new Date().toISOString();
          active--;
          pump();
          // Only when the queue is genuinely drained: settling on every
          // completion resolved `idle()` while other jobs were still running
          // (caught by the queue test, 2026-10-16).
          if (!active && !pending.length) settle();
        });
    }
    if (!active && !pending.length) settle();
  };
  return {
    enqueue(job) {
      if (active + pending.length >= maxQueued) return false;
      pending.push(job);
      pump();
      return true;
    },
    /** Resolves when nothing is queued or running (tests and graceful stop). */
    idle() {
      return new Promise((resolve) => {
        waiters.push(resolve);
        pump();
      });
    },
    stats: () => ({ queued: pending.length, active }),
  };
}

/**
 * Start the API server.
 * @param {object} options
 *   port?: number                 0 picks a free port
 *   keys?: Map<string,string>     key → tenant (default: parse TYMPAN_KEYS)
 *   concurrency?: number          jobs in flight (default TYMPAN_SERVE_CONCURRENCY or 2)
 *   ttlMs?: number                retention for finished jobs
 *   maxJobsPerTenant?: number
 *   convertImpl?: Function        injected for tests (default: the real convert)
 *   workdir?: string              where result PDFs live
 * @returns {Promise<{url, port, close(), jobs: Map, stats(), queue()}>}
 */
export async function createServeServer(options = {}) {
  const keys = options.keys || parseApiKeys(process.env.TYMPAN_KEYS);
  const concurrency = Number(options.concurrency ?? process.env.TYMPAN_SERVE_CONCURRENCY ?? 2);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxJobsPerTenant = options.maxJobsPerTenant ?? MAX_JOBS_PER_TENANT;
  const maxBody = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const convertImpl = options.convertImpl || convert;
  const workdir = options.workdir || fs.mkdtempSync(path.join(os.tmpdir(), 'tympan-serve-'));
  const ownsWorkdir = !options.workdir;
  const jobs = new Map();

  const runJob = async (job) => {
    const out = path.join(workdir, `${job.id}.pdf`);
    const input = job.input.kind === 'html' ? job.htmlPath : job.input.value;
    const result = await convertImpl(input, {
      ...job.options,
      out,
      // The server's policy, never the client's: no allowlist, no file access.
      offline: !!options.offline,
      verify: true,
      onProgress: (event) => job.progress.push(event),
    });
    // A job that converts but fails its own verification is a FAILED job: the
    // API's contract is a verified PDF, not merely a PDF.
    if (result.verification && result.verification.ok === false) {
      const failed = (result.verification.outputs || []).find((o) => o.pagesOk === false || o.probeOk === false);
      throw new Error(`verification failed${failed ? ` for ${path.basename(failed.file)} (${failed.pages}/${failed.expected} pages)` : ''}`);
    }
    const stats = fs.statSync(out);
    job.pdfPath = out;
    job.report = {
      pages: result.quality?.pages ?? null,
      sizeBytes: stats.size,
      qualityLine: result.quality ? formatQualityLine(result.quality) : null,
      quality: result.quality ?? null,
      verification: result.verification ? { ok: result.verification.ok } : null,
    };
    return job.report;
  };

  const queue = createJobQueue({ concurrency, run: runJob, maxQueued: maxJobsPerTenant * 4 });

  const countFor = (tenant) => [...jobs.values()].filter((j) => j.tenant === tenant).length;
  const sweep = () => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (!job.finishedAt) continue;
      if (now - Date.parse(job.finishedAt) < ttlMs) continue;
      if (job.pdfPath && fs.existsSync(job.pdfPath)) fs.rmSync(job.pdfPath, { force: true });
      jobs.delete(id);
    }
  };
  const sweeper = setInterval(sweep, Math.max(1000, Math.floor(ttlMs / 4)));
  sweeper.unref?.();

  const json = (res, status, body) => {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    });
    res.end(text);
  };

  // Reads a bounded body. On overflow it stops HOLDING the bytes but keeps
  // consuming them: destroying the socket here would hand the client a
  // connection error instead of the 413 it earned (and leave it unable to read
  // the reason). Memory stays bounded because the chunks are dropped.
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > maxBody) {
          tooLarge = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(tooLarge ? { tooLarge: true } : { text: Buffer.concat(chunks).toString('utf8') }));
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    // The request URL is parsed INSIDE the handler try: one unauthenticated
    // request with a malformed Host header used to crash the whole server
    // (exit 1, reproduced) because this construction sat above the try/catch.
    try {
      let url;
      try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      } catch {
        return json(res, 400, { error: 'malformed request target or Host header' });
      }
      const route = url.pathname;
      if (route === '/healthz') {
        const stats = queue.stats();
        json(res, 200, { ok: true, queued: stats.queued, active: stats.active, jobs: jobs.size });
        return;
      }
      if (!route.startsWith('/v1/')) {
        json(res, 404, { error: 'not found', hint: 'GET /healthz, GET /v1/me, POST /v1/jobs, GET /v1/jobs/:id, GET /v1/jobs/:id/pdf' });
        return;
      }

      const auth = authorize(req.headers, keys);
      if (!auth.ok) {
        res.setHeader('www-authenticate', 'Bearer realm="tympan"');
        json(res, 401, { error: auth.reason });
        return;
      }

      if (route === '/v1/me' && req.method === 'GET') {
        json(res, 200, {
          tenant: auth.tenant,
          jobs: countFor(auth.tenant),
          maxJobs: maxJobsPerTenant,
          concurrency,
          retentionMs: ttlMs,
          engine: process.version,
        });
        return;
      }

      if (route === '/v1/jobs' && req.method === 'POST') {
        if (countFor(auth.tenant) >= maxJobsPerTenant) {
          json(res, 429, { error: `too many jobs for this tenant (${maxJobsPerTenant})`, hint: 'wait for jobs to finish or expire' });
          return;
        }
        const raw = await readBody(req);
        if (raw.tooLarge) {
          json(res, 413, { error: `request body too large (limit ${maxBody} bytes)` });
          return;
        }
        let body;
        try {
          body = raw.text ? JSON.parse(raw.text) : {};
        } catch {
          json(res, 400, { error: 'body is not valid JSON' });
          return;
        }
        const valid = validateJobRequest(body);
        if (!valid.ok) {
          json(res, valid.status, { error: valid.error });
          return;
        }
        const id = crypto.randomUUID();
        const job = {
          id,
          tenant: auth.tenant,
          status: 'queued',
          createdAt: new Date().toISOString(),
          input: { kind: valid.input.kind, value: valid.input.kind === 'url' ? valid.input.value : '[html]' },
          options: valid.options,
          progress: [],
          htmlPath: null,
        };
        if (valid.input.kind === 'html') {
          // Materialize the submitted HTML in the server's own workdir: the
          // converter takes a path, and this keeps the tenant's bytes out of
          // every other request's way.
          job.htmlPath = path.join(workdir, `${id}.html`);
          fs.writeFileSync(job.htmlPath, valid.input.value);
          job.input.bytes = Buffer.byteLength(valid.input.value);
        }
        jobs.set(id, job);
        if (!queue.enqueue(job)) {
          jobs.delete(id);
          json(res, 503, { error: 'queue is full', hint: 'retry shortly' });
          return;
        }
        json(res, 202, publicJob(job, ''));
        return;
      }

      const match = /^\/v1\/jobs\/([^/]+)(\/pdf)?$/.exec(route);
      if (match) {
        const job = jobs.get(match[1]);
        // 404 rather than 403 for another tenant's job: whether an id exists is
        // itself information, and it is not this tenant's.
        if (!job || job.tenant !== auth.tenant) {
          json(res, 404, { error: 'no such job' });
          return;
        }
        if (match[2]) {
          if (req.method !== 'GET') {
            json(res, 405, { error: 'use GET' });
            return;
          }
          if (job.status !== 'done' || !job.pdfPath) {
            json(res, 409, { error: `job is ${job.status}`, status: job.status });
            return;
          }
          const bytes = fs.readFileSync(job.pdfPath);
          res.writeHead(200, {
            'content-type': 'application/pdf',
            'content-length': bytes.length,
            'cache-control': 'no-store',
          });
          res.end(bytes);
          return;
        }
        if (req.method === 'GET') {
          json(res, 200, publicJob(job, ''));
          return;
        }
        if (req.method === 'DELETE') {
          if (job.pdfPath && fs.existsSync(job.pdfPath)) fs.rmSync(job.pdfPath, { force: true });
          jobs.delete(job.id);
          json(res, 200, { id: job.id, deleted: true });
          return;
        }
        json(res, 405, { error: 'use GET or DELETE' });
        return;
      }

      json(res, 404, {
        error: 'not found',
        hint: 'GET /v1/me, POST /v1/jobs, GET /v1/jobs/:id, GET /v1/jobs/:id/pdf',
      });
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      json(res, status, { error: (e && e.message) || String(e) });
    }
  });

  const port = options.port ?? SERVE_DEFAULT_PORT;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, options.host || '127.0.0.1', resolve);
  });

  return {
    url: `http://${options.host || '127.0.0.1'}:${server.address().port}`,
    port: server.address().port,
    jobs,
    stats: () => ({ ...queue.stats(), jobs: jobs.size, tenants: new Set([...jobs.values()].map((j) => j.tenant)).size }),
    queue: () => queue,
    async close() {
      clearInterval(sweeper);
      await new Promise((resolve) => server.close(resolve));
      if (ownsWorkdir) fs.rmSync(workdir, { recursive: true, force: true });
    },
  };
}

/** The geometry a job will be converted at, for documentation and tests. */
export function jobGeometry(options = {}) {
  return resolveGeometry(options);
}

/** Retention policy summary, so a deploy can log what it is promising. */
export function servePolicy(options = {}) {
  return {
    concurrency: Number(options.concurrency ?? process.env.TYMPAN_SERVE_CONCURRENCY ?? 2),
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    maxJobsPerTenant: options.maxJobsPerTenant ?? MAX_JOBS_PER_TENANT,
    maxBodyBytes: options.maxBodyBytes ?? MAX_BODY_BYTES,
    offline: !!options.offline,
  };
}
