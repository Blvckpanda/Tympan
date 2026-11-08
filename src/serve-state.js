/**
 * serve-state.js — `tympan serve`'s opt-in production-shaped state dir.
 *
 * Three seams of the spike (`docs/SERVE.md`'s own roadmap) live here, and
 * only these three:
 *
 *   keys    hashed at rest (sha256 of the secret — the plaintext never lives
 *           in a file), with rotation via `serve keys add/revoke`;
 *   jobs    one JSON file per job under jobs/, written at every status
 *           transition with an atomic tmp+rename, so a restart can re-queue
 *           incomplete work instead of losing it;
 *   meter   per-tenant accounting (jobs by outcome, pages, bytes, convert
 *           milliseconds), persisted on every job finish — the counting
 *           happens in memory either way; the file only makes it survive.
 *
 * Without `--state-dir` none of this touches disk: the spike behaves exactly
 * as documented (memory keys from TYMPAN_KEYS, temp workdir, temp meter),
 * because a server that writes directories the operator did not name is
 * worse than a spike. Deliberately NOT here: object storage, a database, a
 * broker — a directory of JSON files is the scribbling of a single machine,
 * and the roadmap says so.
 *
 * Every write is atomic: `.tmp` + rename, so a crash mid-write leaves the
 * previous file intact and a reader never sees a torn JSON.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** The version field every written file carries, and refuses crosses of. */
export const STATE_VERSION = 1;

/** sha256 of an API key, at rest and at compare time. Plain-text keys must never be stored. */
export function hashKey(key) {
  return crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

/** First 8 hex chars of a hash: enough to identify a record in listings. */
export function keyFingerprint(hash) {
  return String(hash).slice(0, 8);
}

function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * The state dir: keys, jobs, meter. All methods are synchronous and cheap —
 * each write is one small file.
 * @param {string} dir the operator-named directory (created lazily)
 */
export function openServeState(dir) {
  if (!dir) throw new Error('serve state requires a directory');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'jobs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'payloads'), { recursive: true });

  return {
    dir,

    // ------------------------------------------------------------ keys
    keysFile: () => path.join(dir, 'tenants.json'),

    /** All records as [{ hash, tenant, createdAt }]; corrupt file -> none. */
    loadKeys() {
      const parsed = readJson(this.keysFile(), null);
      if (!parsed || parsed.version !== STATE_VERSION || !Array.isArray(parsed.keys)) {
        return [];
      }
      return parsed.keys.filter(
        (k) => k && typeof k.hash === 'string' && typeof k.tenant === 'string' && k.hash.length === 64
      );
    },

    /** Add (idempotent on the hash); returns true when the file changed. */
    addKey(hash, tenant) {
      const keys = this.loadKeys();
      if (keys.some((k) => k.hash === hash)) return false;
      keys.push({ hash, tenant, createdAt: new Date().toISOString() });
      atomicWrite(this.keysFile(), JSON.stringify({ version: STATE_VERSION, keys }, null, 2) + '\n');
      return true;
    },

    /** Remove a record by full hash; returns true when one was removed. */
    revokeKey(hash) {
      const keys = this.loadKeys();
      const kept = keys.filter((k) => k.hash !== hash);
      if (kept.length === keys.length) return false;
      atomicWrite(this.keysFile(), JSON.stringify({ version: STATE_VERSION, keys: kept }, null, 2) + '\n');
      return true;
    },

    // ------------------------------------------------------------ jobs
    jobFile: (id) => path.join(dir, 'jobs', `${id}.json`),

    loadJobs() {
      try {
        const files = fs.readdirSync(path.join(dir, 'jobs'));
        const out = [];
        for (const f of files.filter((f) => f.endsWith('.json'))) {
          const job = readJson(path.join(dir, 'jobs', f), null);
          if (job && job.id) out.push(job);
        }
        return out;
      } catch {
        return [];
      }
    },

    saveJob(job) {
      // Persist the transcript the API needs to rebuild itself after a
      // restart, minus what no file should hold: no tenant HTML payload
      // (lives under payloads/), no progress transcript.
      const { htmlPath, pdfPath, progress, ...persisted } = job;
      void htmlPath; void pdfPath; void progress;
      atomicWrite(this.jobFile(job.id), JSON.stringify(persisted, null, 2) + '\n');
    },

    dropJob(id) {
      try {
        fs.rmSync(this.jobFile(id), { force: true });
      } catch {
        /* tolerated: the sweep is best-effort */
      }
    },

    /** A payload the server reads (html source) or wrote (the PDF). */
    payloadPath: (id, kind) => path.join(dir, 'payloads', `${id}.${kind}`),
    payloadExists: (id, kind) => fs.existsSync(path.join(dir, 'payloads', `${id}.${kind}`)),

    // ----------------------------------------------------------- meter
    meterFile: () => path.join(dir, 'meter.json'),

    loadMeter() {
      const parsed = readJson(this.meterFile(), null);
      if (!parsed || parsed.version !== STATE_VERSION || typeof parsed.tenants !== 'object') {
        return { version: STATE_VERSION, tenants: {} };
      }
      return parsed;
    },

    saveMeter(meter) {
      atomicWrite(this.meterFile(), JSON.stringify(meter, null, 2) + '\n');
    },
  };
}

/**
 * A meter row: one column per counted thing, said once.
 * @returns {{submitted: number, succeeded: number, failed: number, pages: number,
 *   bytes: number, convertMs: number}}
 */
export function emptyMeterRow() {
  return { submitted: 0, succeeded: 0, failed: 0, pages: 0, bytes: 0, convertMs: 0 };
}

/** Bump a tenant's meter with one job outcome. Pure on the row it returns. */
export function meterJobUpdate(row, job, report) {
  const out = { ...row };
  if (job.status === 'done') {
    out.succeeded += 1;
    out.pages += report && report.pages ? report.pages : 0;
    out.bytes += report && report.sizeBytes ? report.sizeBytes : 0;
  } else if (job.status === 'failed') {
    out.failed += 1;
  }
  if (job.startedAt && job.finishedAt) {
    const ms = Date.parse(job.finishedAt) - Date.parse(job.startedAt);
    if (Number.isFinite(ms) && ms >= 0) out.convertMs += ms;
  }
  return out;
}
