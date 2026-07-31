/**
 * Shared Drive plumbing for index.js, verify.js and getMissing.js.
 *
 * Everything that decides how hard we hit the API lives here — the adaptive
 * rate governor, the retry/backoff policy, the FIFO queue, paginated listing
 * and the status block — so a fix to any of it applies to every script instead
 * of being copied into three files that then drift apart.
 *
 * The one thing deliberately *not* shared is authorization: index.js runs the
 * interactive consent flow, the companion scripts read an existing token.json.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';

// Loaded here rather than only in the entry scripts: ESM evaluates an imported
// module's body *before* the importer's body, so a dotenv.config() call in
// index.js would run after the constants below had already read an empty
// process.env.
dotenv.config({ quiet: true });

/**
 * True when the calling module is the process entry point (node, PM2, etc.).
 *
 * The caller MUST pass its own `import.meta.url`. There is no defaulting it
 * here: `import.meta.url` resolves lexically, so a default value written in
 * this file would always be *this* file's URL and every caller's guard would
 * be false — the scripts would import and then silently do nothing.
 */
export function isMainModule(metaUrl) {
  if (!metaUrl) {
    throw new TypeError('isMainModule(import.meta.url): pass the caller’s import.meta.url');
  }
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === metaUrl;
}

export const VERBOSE =
  process.argv.includes('--verbose') ||
  process.argv.includes('-v') ||
  process.env.VERBOSE === '1';

/** Reads a positive number from env, falling back when unset/blank/invalid. */
export function envNum(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Folder-walker workers (listing-heavy, mostly read quota). */
export const WALK_CONCURRENCY = Math.floor(envNum('WALK_CONCURRENCY', 6, { min: 1, max: 32 }));
/** File-copy workers (write quota). */
export const COPY_CONCURRENCY = Math.floor(envNum('COPY_CONCURRENCY', 8, { min: 1, max: 32 }));

/** Starting/ceiling request rates per second. AIMD moves between them at runtime. */
export const READ_RATE = envNum('READ_RATE', 15, { min: 0.5, max: 200 });
export const READ_RATE_MAX = Math.max(
  READ_RATE,
  envNum('READ_RATE_MAX', 40, { min: 0.5, max: 400 }),
);
export const WRITE_RATE = envNum('WRITE_RATE', 6, { min: 0.2, max: 200 });
export const WRITE_RATE_MAX = Math.max(
  WRITE_RATE,
  envNum('WRITE_RATE_MAX', 20, { min: 0.2, max: 400 }),
);

/** Cap on queued-but-uncopied files, so walkers cannot outrun copiers unboundedly. */
export const FILE_QUEUE_MAX = Math.floor(envNum('FILE_QUEUE_MAX', 20_000, { min: 100 }));

/**
 * Google Docs workers in updateDocLinks.js. Capped low on purpose: each doc is
 * a read plus one or more batchUpdate writes against the Docs API, whose quota
 * is far tighter than Drive's.
 */
export const DOC_CONCURRENCY = Math.floor(envNum('DOC_CONCURRENCY', 4, { min: 1, max: 8 }));

/**
 * Docs API request rates. Deliberately its own bucket: the Docs quota is
 * separate from Drive's, so a Docs 429 must not throttle Drive listing (or
 * vice versa). Conservative by default — the old code effectively self-limited
 * to ~5 req/s by sleeping 200ms between calls.
 */
export const DOCS_RATE = envNum('DOCS_RATE', 3, { min: 0.2, max: 100 });
export const DOCS_RATE_MAX = Math.max(DOCS_RATE, envNum('DOCS_RATE_MAX', 8, { min: 0.2, max: 200 }));

/** Max retries per API call for transient errors. */
export const MAX_RETRIES = Math.max(
  1,
  Math.floor(envNum('DRIVE_MAX_RETRIES', 10, { min: 1, max: 50 })),
);

/** How often the two-line status block is printed (ms). */
export const LOG_INTERVAL_MS = envNum('LOG_INTERVAL_MS', 1000, { min: 200, max: 60_000 });

/**
 * Depth cap for the path-based walk in verify.js / getMissing.js. Those walks
 * dedupe by (id, path) rather than by id, so a pathological multi-parent graph
 * could otherwise generate ever-deeper paths forever.
 */
export const MAX_WALK_DEPTH = Math.floor(envNum('MAX_WALK_DEPTH', 100, { min: 1, max: 1000 }));

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

export const ISSUE_LOG = path.join(process.cwd(), 'logs', 'issues.log');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function truncateName(name, max = 45) {
  const s = String(name ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Token bucket with additive-increase / multiplicative-decrease adaptation.
 *
 * Rate and concurrency are deliberately separate concerns: workers exist to hide
 * round-trip latency, this exists to keep total requests/sec under whatever
 * Drive is willing to serve right now. Because every worker draws from the same
 * bucket, a penalty applies to all of them at once.
 */
export class RateGovernor {
  constructor(name, { rate, maxRate, minRate }) {
    this.name = name;
    this.rate = rate;
    this.maxRate = maxRate;
    this.minRate = minRate;
    this.step = Math.max(0.5, maxRate * 0.05);
    this.burst = Math.max(1, Math.min(rate, 10));
    this.tokens = this.burst;
    this.last = Date.now();
    this.pausedUntil = 0;
    this.lastPenaltyAt = 0;
    this.lastRaiseAt = 0;
    this.penalties = 0;
  }

  async take() {
    for (;;) {
      const now = Date.now();
      if (now < this.pausedUntil) {
        await sleep(Math.min(1000, this.pausedUntil - now));
        continue;
      }
      const elapsedSec = (now - this.last) / 1000;
      if (elapsedSec > 0) {
        this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.rate);
        this.last = now;
      }
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - this.tokens) / this.rate) * 1000);
      await sleep(Math.max(5, Math.min(500, waitMs)));
    }
  }

  /** Drive pushed back: cut the rate and stall every worker for pauseMs. */
  penalize(pauseMs = 0) {
    const now = Date.now();
    // Every in-flight worker reports the same throttling episode, so cut the
    // rate only once per pause window. Without this, N workers each apply
    // ×0.6 and the rate collapses by 0.6^N from a single episode.
    if (now >= this.pausedUntil) {
      this.rate = Math.max(this.minRate, this.rate * 0.6);
      this.burst = Math.max(1, Math.min(this.rate, 10));
      this.penalties += 1;
    }
    this.tokens = 0;
    this.lastPenaltyAt = now;
    this.pausedUntil = Math.max(this.pausedUntil, now + pauseMs);
  }

  /**
   * Creep back toward the ceiling once things have been calm for a while.
   * Time-based rather than success-count-based: a steady trickle of unrelated
   * errors must not pin the rate at the floor forever.
   */
  reward() {
    if (this.rate >= this.maxRate) return;
    const now = Date.now();
    if (now - this.lastPenaltyAt < 5000) return;
    if (now - this.lastRaiseAt < 2000) return;
    this.lastRaiseAt = now;
    this.rate = Math.min(this.maxRate, this.rate + this.step);
    this.burst = Math.max(1, Math.min(this.rate, 10));
  }
}

// Floors are deliberately not tiny: a governor pinned at 0.2/s would turn a
// 30k-file migration into days. Sustained failure should surface as errors.
export const governors = {
  read: new RateGovernor('read', { rate: READ_RATE, maxRate: READ_RATE_MAX, minRate: 1 }),
  write: new RateGovernor('write', { rate: WRITE_RATE, maxRate: WRITE_RATE_MAX, minRate: 0.5 }),
  docs: new RateGovernor('docs', { rate: DOCS_RATE, maxRate: DOCS_RATE_MAX, minRate: 0.5 }),
};

/** FIFO with amortized O(1) dequeue — plain Array#shift is O(n) at 30k+ jobs. */
export class Queue {
  constructor() {
    this.items = [];
    this.head = 0;
  }

  push(item) {
    this.items.push(item);
  }

  shift() {
    if (this.head >= this.items.length) return undefined;
    const value = this.items[this.head];
    this.items[this.head] = undefined;
    this.head += 1;
    if (this.head > 4096 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return value;
  }

  get size() {
    return this.items.length - this.head;
  }
}

function parseRetryAfterMs(headers) {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw == null) return null;
  const sec = Number(raw);
  if (!Number.isFinite(sec)) return null;
  return Math.min(120_000, Math.max(0, sec * 1000));
}

function isUserRateLimitError(err) {
  const status = err?.response?.status ?? err?.code;
  if (status !== 403) return false;
  const msg = String(err?.response?.data?.error?.message ?? err?.message ?? '').toLowerCase();
  if (msg.includes('rate limit') || msg.includes('quota')) return true;
  const errors = err?.response?.data?.error?.errors;
  if (Array.isArray(errors)) {
    return errors.some(
      (e) =>
        e?.reason === 'userRateLimitExceeded' ||
        e?.reason === 'rateLimitExceeded' ||
        String(e?.message ?? '').toLowerCase().includes('rate'),
    );
  }
  return false;
}

/** Retry noise is throttled — 14 workers hitting one limit must not spam 14 lines. */
const limitLog = { last: 0 };
function noteThrottle(message) {
  const now = Date.now();
  if (now - limitLog.last < 3000) return;
  limitLog.last = now;
  console.log(`[limit] ${message}`);
}

export const apiStats = { retries: 0, calls: 0 };

/**
 * Single entry point for every Drive request: rate-governed, retried, and
 * self-throttling. `kind` selects which quota bucket the call is charged to.
 */
export async function driveCall(kind, label, fn) {
  const gov = governors[kind];
  let attempt = 0;
  let lastErr;

  while (attempt < MAX_RETRIES) {
    await gov.take();
    try {
      const res = await fn();
      apiStats.calls += 1;
      gov.reward();
      return res;
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status ?? err?.code;
      const rateLimited = status === 429 || isUserRateLimitError(err);
      const retryable =
        rateLimited ||
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        err?.message?.includes?.('ECONNRESET') ||
        err?.message?.includes?.('ETIMEDOUT') ||
        err?.message?.includes?.('EAI_AGAIN') ||
        err?.message?.includes?.('socket hang up');

      if (!retryable || attempt === MAX_RETRIES - 1) throw err;

      apiStats.retries += 1;
      const fromHeader = parseRetryAfterMs(err?.response?.headers);

      if (rateLimited) {
        // Global penalty: every worker on this bucket slows down together.
        const pause = fromHeader ?? Math.min(60_000, 1000 * 2 ** attempt);
        gov.penalize(pause);
        noteThrottle(`${kind} rate cut to ${gov.rate.toFixed(1)}/s (${status}); pausing ${pause}ms`);
      } else {
        const backoff = fromHeader ?? Math.min(30_000, 500 * 2 ** attempt);
        await sleep(backoff + Math.floor(Math.random() * 250));
      }
      attempt += 1;
    }
  }
  throw lastErr;
}

/**
 * Google Docs API call: same retry and AIMD machinery as driveCall, charged to
 * the separate `docs` bucket so Docs throttling never slows Drive listing.
 */
export function docsCall(label, fn) {
  return driveCall('docs', label, fn);
}

/**
 * Runs `handler` over `items` with at most `concurrency` in flight, returning
 * results in **input order** regardless of completion order — callers write
 * ordered JSON logs from it, so completion order must not leak through.
 *
 * `handler` is expected to deal with its own failures; a throw rejects the
 * whole pool.
 */
export async function runPool(items, concurrency, handler) {
  const results = new Array(items.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      // Claim an index synchronously — no await between read and increment, so
      // two workers can never take the same item.
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await handler(items[i], i);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()),
  );
  return results;
}

/** Serialized appends so concurrent workers cannot interleave a log line. */
let logDirReady = null;
let issueLogChain = Promise.resolve();
export function appendIssue(kind, detail) {
  logDirReady ??= fs.mkdir(path.dirname(ISSUE_LOG), { recursive: true }).catch(() => {});
  const line = `${new Date().toISOString()}\t${kind}\t${detail}\n`;
  issueLogChain = issueLogChain
    .then(() => logDirReady)
    .then(() => fs.appendFile(ISSUE_LOG, line, 'utf8'))
    .catch(() => {});
  return issueLogChain;
}

/** Awaits every append queued so far — call before the process exits. */
export function flushIssues() {
  return issueLogChain;
}

/**
 * Records a per-item failure without aborting the run: it counts toward
 * `ctx.stats.errors`, keeps the first 50 messages for the closing summary, and
 * always lands in logs/issues.log.
 */
export function recordFailure(ctx, label, err) {
  const message = String(
    err?.response?.data?.error?.message ?? err?.message ?? err,
  ).replace(/\s+/g, ' ');
  ctx.stats.errors += 1;
  if (ctx.failures.length < 50) ctx.failures.push(`${label}: ${message}`);
  appendIssue('error', `${label}\t${message}`);
}

/** Lists every non-trashed child of a folder, following pagination. */
export async function listChildren(drive, folderId) {
  const q = `'${folderId}' in parents and trashed = false`;
  const all = [];
  let pageToken;

  do {
    const res = await driveCall('read', `files.list ${folderId}`, () =>
      drive.files.list({
        q,
        pageSize: 1000,
        pageToken: pageToken || undefined,
        fields: 'nextPageToken, files(id, name, mimeType, shortcutDetails)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );
    const files = res.data.files ?? [];
    for (const f of files) all.push(f);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return all;
}

/**
 * Prints a fixed status block once per interval from whatever lines the caller
 * renders. Plain console lines only — no cursor tricks — so retry/warn logs
 * stay readable.
 */
export function createStatusPrinter(renderLines, { intervalMs = LOG_INTERVAL_MS } = {}) {
  let timer = null;

  const tick = () => {
    const lines = renderLines().filter((line) => line != null && line !== '');
    if (lines.length === 0) return;
    // Rule spans the widest line so each tick reads as one block; recomputed
    // every tick so a terminal resize is picked up.
    const widest = lines.reduce((max, line) => Math.max(max, line.length), 0);
    const rule = '-'.repeat(
      Math.max(1, Math.min(widest, (process.stdout.columns || 120) - 1)),
    );

    console.log(rule);
    for (const line of lines) console.log(line);
    console.log(rule);
  };

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      tick();
    },
  };
}

/**
 * Pooled, path-first walk of one or more trees, used by verify.js and
 * getMissing.js (index.js has its own walker because it interleaves target
 * listing and copy decisions in the same pass).
 *
 * All roots share one pool of WALK_CONCURRENCY workers, so the source and
 * target walks overlap and the governor sees a single combined request stream
 * instead of two pools competing for the same quota.
 *
 * @param {import('googleapis').drive_v3.Drive} drive
 * @param {Array<{side: string, id: string, path?: string}>} roots
 *   `path` seeds the prefix every discovered path is built under (default '').
 * @param {{
 *   queues: {folders: Queue},
 *   visited: Set<string>,
 *   scan: Record<string, {folders: number, files: number}>,
 *   runtime: {currentFolder: string, currentFile: string},
 *   stats: {errors: number, foldersDeduped: number, shortcuts: number},
 *   failures: string[],
 *   aborted: boolean,
 *   onFile: (side: string, fullPath: string, file: object) => void,
 *   onFolder?: (side: string, fullPath: string, folder: object) => void,
 * }} ctx
 */
export async function walkTrees(drive, roots, ctx) {
  const { queues, visited } = ctx;

  for (const root of roots) {
    const rootPath = root.path ?? '';
    visited.add(`${root.side}\u0000${root.id}\u0000${rootPath}`);
    queues.folders.push({ side: root.side, id: root.id, path: rootPath, depth: 0 });
  }

  let active = 0;

  const worker = async () => {
    for (;;) {
      if (ctx.aborted) return;
      const job = queues.folders.shift();
      if (!job) {
        // An in-flight walker can still enqueue more, so workers only exit once
        // the queue is empty *and* nobody is mid-listing.
        if (active === 0) return;
        await sleep(25);
        continue;
      }
      active += 1;
      try {
        await walkOneFolder(drive, job, ctx);
      } catch (err) {
        // A subtree we cannot list must not sink the run; it is logged and the
        // caller reports a non-zero exit so the results are known incomplete.
        recordFailure(ctx, `list ${job.side}:${job.path || '/'}`, err);
      } finally {
        active -= 1;
      }
    }
  };

  await Promise.all(Array.from({ length: WALK_CONCURRENCY }, () => worker()));
}

async function walkOneFolder(drive, job, ctx) {
  const { visited, scan, runtime, stats, queues } = ctx;
  runtime.currentFolder = `${job.side}:${job.path || '/'}`;

  const children = await listChildren(drive, job.id);
  scan[job.side].folders += 1;

  for (const item of children) {
    const { id, name, mimeType } = item;
    if (!id || !name) continue;
    const fullPath = job.path ? `${job.path}/${name}` : name;

    if (mimeType === FOLDER_MIME) {
      ctx.onFolder?.(job.side, fullPath, item);

      // Drive allows an item to have several parents, so the same folder can
      // surface under two listings. index.js dedupes on id (it copies each
      // folder once); here the comparison is by *path*, so the same folder
      // reached by two paths is two entries and the visit key has to include
      // the path. Repeat visits and cycles still stop here.
      const key = `${job.side}\u0000${id}\u0000${fullPath}`;
      if (visited.has(key)) {
        stats.foldersDeduped += 1;
        continue;
      }
      visited.add(key);

      if (job.depth + 1 > MAX_WALK_DEPTH) {
        appendIssue('depth-limit', `${job.side}:${fullPath} deeper than MAX_WALK_DEPTH=${MAX_WALK_DEPTH}`);
        continue;
      }

      queues.folders.push({ side: job.side, id, path: fullPath, depth: job.depth + 1 });
      continue;
    }

    // Shortcuts count as files here, exactly as they did before: these scripts
    // compare by path, and a shortcut occupies a path. index.js does not copy
    // them, so they legitimately show up as missing in the target.
    if (mimeType === SHORTCUT_MIME) stats.shortcuts += 1;

    scan[job.side].files += 1;
    runtime.currentFile = name;
    ctx.onFile(job.side, fullPath, item);
  }
}

/** Fresh ctx scaffolding for a walkTrees run over source + target. */
export function createWalkContext(extra = {}) {
  return {
    queues: { folders: new Queue() },
    visited: new Set(),
    scan: {
      source: { folders: 0, files: 0 },
      target: { folders: 0, files: 0 },
    },
    runtime: { currentFolder: '', currentFile: 'starting…' },
    stats: { errors: 0, foldersDeduped: 0, shortcuts: 0 },
    failures: [],
    aborted: false,
    done: false,
    ...extra,
  };
}
