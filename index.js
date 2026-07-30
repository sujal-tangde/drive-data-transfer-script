/**
 * Migrates a shared folder tree into the authenticated (target) user's Drive
 * using drive.files.list + drive.files.create (folders) + drive.files.copy (files).
 * Native Google Workspace files stay native (no export/import).
 *
 * The SOURCE folder is read-only: list + copy only. Deletes apply to TARGET
 * duplicates only in --continue-with-re-copy mode, never to source items.
 *
 * Concurrency model
 *   - A folder queue is drained by WALK_CONCURRENCY walkers. Each source folder
 *     is enqueued exactly once, so exactly one worker ever writes into a given
 *     target folder. Concurrent check-then-create on the same parent — the way
 *     duplicate folders get made — is therefore impossible by construction.
 *   - Walkers enqueue file jobs, drained by COPY_CONCURRENCY copiers. Traversal
 *     (reads) and copying (writes) overlap instead of blocking each other.
 *   - Every API call passes a governor holding separate read/write token buckets
 *     with AIMD adaptation, so a single 403 slows the whole fleet rather than
 *     letting each caller back off alone and stampede back in together.
 *
 * Resume modes:
 *   --continue-if-incomplete   skip files already present in target (default)
 *   --continue-with-re-copy    delete+re-copy same-named target files, then continue
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';
import { google } from 'googleapis';
import dotenv from 'dotenv';
dotenv.config();

const VERBOSE =
  process.argv.includes('--verbose') ||
  process.argv.includes('-v') ||
  process.env.VERBOSE === '1';

const WANT_CONTINUE_IF_INCOMPLETE = process.argv.includes('--continue-if-incomplete');
const WANT_CONTINUE_WITH_RE_COPY = process.argv.includes('--continue-with-re-copy');

if (WANT_CONTINUE_IF_INCOMPLETE && WANT_CONTINUE_WITH_RE_COPY) {
  console.error(
    'Use only one of --continue-if-incomplete or --continue-with-re-copy (not both).',
  );
  process.exit(1);
}

/** 'skip' = resume without re-copying; 'recopy' = replace existing target files. */
const COPY_MODE = WANT_CONTINUE_WITH_RE_COPY ? 'recopy' : 'skip';

const SCOPES = ['https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents'
];

const SOURCE_FOLDER_ID = process.env.SOURCE_FOLDER_ID;
const TARGET_FOLDER_ID = process.env.TARGET_FOLDER_ID;
const CREDENTIALS_PATH =
  process.env.GOOGLE_OAUTH_CREDENTIALS || path.join(process.cwd(), 'credentials.json');
const TOKEN_PATH = process.env.GOOGLE_OAUTH_TOKEN || path.join(process.cwd(), 'token.json');
const LOCK_PATH = path.join(process.cwd(), '.migrate.lock');
const ISSUE_LOG = path.join(process.cwd(), 'logs', 'issues.log');

console.log({
  CREDENTIALS_PATH,
  SOURCE_FOLDER_ID,
  TARGET_FOLDER_ID,
  TOKEN_PATH
})

/** Reads a positive number from env, falling back when unset/blank/invalid. */
function envNum(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Folder-walker workers (listing-heavy, mostly read quota). */
const WALK_CONCURRENCY = Math.floor(envNum('WALK_CONCURRENCY', 6, { min: 1, max: 32 }));
/** File-copy workers (write quota). */
const COPY_CONCURRENCY = Math.floor(envNum('COPY_CONCURRENCY', 8, { min: 1, max: 32 }));

/** Starting/ceiling request rates per second. AIMD moves between them at runtime. */
const READ_RATE = envNum('READ_RATE', 15, { min: 0.5, max: 200 });
const READ_RATE_MAX = Math.max(READ_RATE, envNum('READ_RATE_MAX', 40, { min: 0.5, max: 400 }));
const WRITE_RATE = envNum('WRITE_RATE', 6, { min: 0.2, max: 200 });
const WRITE_RATE_MAX = Math.max(WRITE_RATE, envNum('WRITE_RATE_MAX', 20, { min: 0.2, max: 400 }));

/** Cap on queued-but-uncopied files, so walkers cannot outrun copiers unboundedly. */
const FILE_QUEUE_MAX = Math.floor(envNum('FILE_QUEUE_MAX', 20_000, { min: 100 }));

/** Max retries per API call for transient errors. */
const MAX_RETRIES = Math.max(1, Math.floor(envNum('DRIVE_MAX_RETRIES', 10, { min: 1, max: 50 })));

/** How often the two-line status block is printed (ms). */
const LOG_INTERVAL_MS = envNum('LOG_INTERVAL_MS', 1000, { min: 200, max: 60_000 });

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function truncateName(name, max = 45) {
  const s = String(name ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function formatDuration(ms) {
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
class RateGovernor {
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
const governors = {
  read: new RateGovernor('read', { rate: READ_RATE, maxRate: READ_RATE_MAX, minRate: 1 }),
  write: new RateGovernor('write', { rate: WRITE_RATE, maxRate: WRITE_RATE_MAX, minRate: 0.5 }),
};

/** FIFO with amortized O(1) dequeue — plain Array#shift is O(n) at 30k+ jobs. */
class Queue {
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

const apiStats = { retries: 0, calls: 0 };

/**
 * Single entry point for every Drive request: rate-governed, retried, and
 * self-throttling. `kind` selects which quota bucket the call is charged to.
 */
async function driveCall(kind, label, fn) {
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

async function loadSavedCredentials() {
  try {
    const raw = await fs.readFile(TOKEN_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveCredentials(token) {
  await fs.writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), 'utf8');
}

function isInvalidGrant(err) {
  const data = err?.response?.data;
  return (
    data?.error === 'invalid_grant' ||
    err?.code === 'invalid_grant' ||
    String(err?.message ?? '').toLowerCase().includes('invalid_grant')
  );
}

async function requestNewCredentials(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });

  console.log('Authorize this app (sign in as the TARGET account):');
  console.log(authUrl);
  const rl = readline.createInterface({ input, output });
  try {
    const code = await rl.question('Enter the authorization code here: ');
    const { tokens } = await oAuth2Client.getToken(code.trim());
    oAuth2Client.setCredentials(tokens);
    await saveCredentials(tokens);
  } finally {
    rl.close();
  }

  return oAuth2Client;
}

async function authorize() {
  const content = await fs.readFile(CREDENTIALS_PATH, 'utf8');
  const keys = JSON.parse(content);
  const { client_secret, client_id, redirect_uris } = keys.installed ?? keys.web ?? {};
  if (!client_id || !client_secret) {
    throw new Error(
      `Invalid OAuth client file at ${CREDENTIALS_PATH}. Expected "installed" or "web" with client_id and client_secret.`,
    );
  }
  const redirectUri =
    (redirect_uris && redirect_uris[0]) || 'http://localhost';

  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const token = await loadSavedCredentials();
  if (token) {
    oAuth2Client.setCredentials(token);
    try {
      // Force token validation now so an expired/revoked refresh token can be
      // replaced before the migration starts.
      await oAuth2Client.getAccessToken();
      return oAuth2Client;
    } catch (err) {
      if (!isInvalidGrant(err)) throw err;

      console.warn(
        'Saved Google authorization has expired or was revoked. Starting sign-in again…',
      );
      await fs.rm(TOKEN_PATH, { force: true });
      oAuth2Client.setCredentials({});
    }
  }

  return requestNewCredentials(oAuth2Client);
}

/**
 * Only one migration may run at a time: two concurrent runs would each hold
 * their own view of the target tree and duplicate everything they both create.
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

let lockHeld = false;

async function acquireLock() {
  let raw = null;
  try {
    raw = await fs.readFile(LOCK_PATH, 'utf8');
  } catch {
    raw = null;
  }

  if (raw) {
    let pid = null;
    try {
      pid = JSON.parse(raw)?.pid ?? null;
    } catch {
      pid = null;
    }
    if (pid && pid !== process.pid && isProcessAlive(pid)) {
      throw new Error(
        `Another migration is already running (pid ${pid}). Running two at once creates duplicates.\n` +
          `Stop it first, or delete ${LOCK_PATH} if that process is gone.`,
      );
    }
  }

  await fs.writeFile(
    LOCK_PATH,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  lockHeld = true;
}

/** Only ever removes a lock this process actually took. */
async function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  await fs.rm(LOCK_PATH, { force: true }).catch(() => {});
}

/** Serialized appends so concurrent workers cannot interleave a log line. */
let logDirReady = null;
let issueLogChain = Promise.resolve();
function appendIssue(kind, detail) {
  logDirReady ??= fs.mkdir(path.dirname(ISSUE_LOG), { recursive: true }).catch(() => {});
  const line = `${new Date().toISOString()}\t${kind}\t${detail}\n`;
  issueLogChain = issueLogChain
    .then(() => logDirReady)
    .then(() => fs.appendFile(ISSUE_LOG, line, 'utf8'))
    .catch(() => {});
  return issueLogChain;
}

function recordFailure(ctx, label, err) {
  const message = String(
    err?.response?.data?.error?.message ?? err?.message ?? err,
  ).replace(/\s+/g, ' ');
  ctx.stats.errors += 1;
  if (ctx.failures.length < 50) ctx.failures.push(`${label}: ${message}`);
  appendIssue('error', `${label}\t${message}`);
}

async function listChildren(drive, folderId) {
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
 * Deletes a duplicate file in the TARGET folder only (never the source).
 * @param {import('googleapis').drive_v3.Drive} drive
 * @param {Set<string>} sourceIds
 */
async function deleteTargetFileIfExists(drive, fileId, label, sourceIds) {
  if (sourceIds.has(fileId)) {
    throw new Error(
      `Refusing to delete "${label}" (${fileId}): this id belongs to the source folder.`,
    );
  }
  await driveCall('write', `files.delete ${label}`, () =>
    drive.files.delete({
      fileId,
      supportsAllDrives: true,
    }),
  );
}

function progressDoneCount(stats) {
  return stats.filesCopied + stats.filesSkipped;
}

/**
 * Prints a fixed two-line status block ([progress] + [scan]) once per interval.
 * Plain console lines only — no cursor tricks — so retry/warn logs stay readable.
 */
function createStatusLogger(stats, walkState, runtime, queues) {
  const startedAt = Date.now();
  let timer = null;

  const tick = () => {
    const processed = progressDoneCount(stats);
    const elapsedMs = Date.now() - startedAt;
    const rate = processed / Math.max(1, elapsedMs / 1000);

    const progress = [
      `[progress] ${processed} processed, ${stats.filesSkipped} skipped, ${stats.filesCopied} copied`,
      `${stats.foldersCreated} folders created, ${stats.foldersReused} reused`,
    ];
    if (stats.filesReplaced) progress.push(`${stats.filesReplaced} replaced`);
    if (stats.skippedShortcuts) progress.push(`${stats.skippedShortcuts} shortcuts`);
    if (stats.errors) progress.push(`${stats.errors} errors`);
    progress.push(`${rate.toFixed(1)} files/s`, `elapsed ${formatDuration(elapsedMs)}`);

    // While the walk is still running, filesFound is a lower bound on the real
    // total, so the percentage is marked approximate until discovery finishes.
    if (walkState.filesFound > 0) {
      const pct = Math.min(100, (processed / walkState.filesFound) * 100);
      const remaining = Math.max(0, walkState.filesFound - processed);
      progress.push(
        `${walkState.done ? '' : '~'}${pct.toFixed(1)}% of ${walkState.filesFound}`,
        `ETA ${rate > 0 ? formatDuration((remaining / rate) * 1000) : '--:--:--'}`,
      );
    }

    const scan = [
      walkState.done
        ? `[scan] walk complete — ${walkState.foldersWalked} folders, ${walkState.filesFound} files`
        : `[scan] walking… ${walkState.foldersWalked} folders, ${walkState.filesFound} files`,
      `queue: ${queues.folders.size} folders / ${queues.files.size} files`,
      `api ${governors.read.rate.toFixed(1)}/s read, ${governors.write.rate.toFixed(1)}/s write`,
    ];
    if (apiStats.retries) scan.push(`${apiStats.retries} retries`);
    if (runtime.currentFolder) scan.push(`in: ${truncateName(runtime.currentFolder, 26)}`);
    scan.push(`now: ${truncateName(runtime.currentFile, 34)}`);

    const progressLine = progress.join(' | ');
    const scanLine = scan.join(' | ');
    // Rule spans the widest line so each tick reads as one block; recomputed
    // every tick so a terminal resize is picked up.
    const rule = '-'.repeat(
      Math.min(
        Math.max(progressLine.length, scanLine.length),
        (process.stdout.columns || 120) - 1,
      ),
    );

    console.log(rule);
    console.log(progressLine);
    console.log(scanLine);
    console.log(rule);
  };

  return {
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, LOG_INTERVAL_MS);
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
 * Mirrors one source folder into its target counterpart: creates/reuses child
 * folders, enqueues child folders for other walkers, and enqueues file copies.
 *
 * This is the only place that writes into `job.targetId`, and each source
 * folder reaches it exactly once — that is what rules out duplicate folders.
 */
async function walkFolder(drive, job, ctx) {
  const { stats, walkState, runtime, queues, sourceIds, visited, copyMode } = ctx;
  runtime.currentFolder = job.name;
  sourceIds.add(job.sourceId);

  const [children, targetChildren] = await Promise.all([
    listChildren(drive, job.sourceId),
    // A folder this run just created is known-empty; listing it is a wasted call.
    job.targetKnownEmpty ? Promise.resolve([]) : listChildren(drive, job.targetId),
  ]);

  const targetByName = new Map();
  for (const child of targetChildren) {
    if (!child.name) continue;
    const bucket = targetByName.get(child.name);
    if (bucket) bucket.push(child);
    else targetByName.set(child.name, [child]);
  }

  for (const item of children) {
    const { id, name, mimeType } = item;
    if (!id || !name) continue;
    sourceIds.add(id);

    if (mimeType === FOLDER_MIME) {
      // Drive allows an item to have several parents, so the same folder can
      // surface under two listings. Walk it once or it gets copied twice.
      if (visited.has(id)) {
        stats.foldersDeduped += 1;
        continue;
      }
      visited.add(id);

      const existingFolders = (targetByName.get(name) ?? []).filter(
        (c) => c.mimeType === FOLDER_MIME && c.id,
      );

      let targetId;
      let targetKnownEmpty = false;
      if (existingFolders.length > 0) {
        targetId = existingFolders[0].id;
        stats.foldersReused += 1;
        if (existingFolders.length > 1) {
          stats.foldersAmbiguous += 1;
          appendIssue(
            'ambiguous-folder',
            `${existingFolders.length} target folders named "${name}"; continuing in the first`,
          );
        }
        if (VERBOSE) console.log(`Using existing folder: ${name}`);
      } else {
        const created = await driveCall('write', `files.create folder ${name}`, () =>
          drive.files.create({
            requestBody: {
              name,
              mimeType: FOLDER_MIME,
              parents: [job.targetId],
            },
            fields: 'id',
            supportsAllDrives: true,
          }),
        );
        targetId = created.data.id;
        if (!targetId) throw new Error(`Folder create returned no id for ${name}`);
        stats.foldersCreated += 1;
        targetKnownEmpty = true;
        if (VERBOSE) console.log(`Created folder: ${name}`);
      }

      queues.folders.push({ sourceId: id, targetId, name, targetKnownEmpty });
      continue;
    }

    if (mimeType === SHORTCUT_MIME) {
      stats.skippedShortcuts += 1;
      appendIssue(
        'shortcut-skipped',
        `${name} -> ${item.shortcutDetails?.targetId ?? '?'} (${item.shortcutDetails?.targetMimeType ?? 'unknown'})`,
      );
      continue;
    }

    walkState.filesFound += 1;
    const existingSameName = (targetByName.get(name) ?? []).filter(
      (c) => c.mimeType !== FOLDER_MIME && c.id,
    );

    // Resume mode: same-named file already in target → skip (no delete, no re-copy).
    // Decided from the listing already in hand, so a skip costs no API call.
    if (copyMode === 'skip' && existingSameName.length > 0) {
      stats.filesSkipped += 1;
      runtime.currentFile = name;
      if (VERBOSE) console.log(`Skipping existing file: ${name}`);
      continue;
    }

    queues.files.push({
      sourceId: id,
      name,
      targetParentId: job.targetId,
      existing: copyMode === 'recopy' ? existingSameName : [],
    });
  }

  walkState.foldersWalked += 1;
}

/** Copies one file into its already-resolved target parent. */
async function copyFile(drive, job, ctx) {
  const { stats, runtime, sourceIds, copyMode } = ctx;
  runtime.currentFile = job.name;

  // Re-copy mode: remove same-named target files, then copy fresh from source.
  if (copyMode === 'recopy') {
    for (const existing of job.existing) {
      if (!existing.id) continue;
      if (VERBOSE) console.log(`Replacing file: ${job.name}`);
      await deleteTargetFileIfExists(drive, existing.id, job.name, sourceIds);
      stats.filesReplaced += 1;
    }
  }

  if (VERBOSE) console.log(`Copying file: ${job.name}`);
  await driveCall('write', `files.copy ${job.name}`, () =>
    drive.files.copy({
      fileId: job.sourceId,
      requestBody: {
        name: job.name,
        parents: [job.targetParentId],
      },
      fields: 'id',
      supportsAllDrives: true,
    }),
  );
  stats.filesCopied += 1;
}

/**
 * Runs both worker pools until every queue is drained.
 *
 * Walkers exit only when the folder queue is empty *and* no walker is mid-job,
 * since an in-flight walker can still enqueue more. Copiers exit only once the
 * walk is finished and the file queue is empty.
 */
async function runPools(drive, ctx) {
  const { queues, stats } = ctx;
  let activeWalkers = 0;
  let walkFinished = false;

  const walker = async () => {
    for (;;) {
      if (ctx.aborted) return;
      // Backpressure: copiers drain independently of this loop, so waiting here
      // cannot deadlock — it just stops discovery from running far ahead.
      if (queues.files.size >= FILE_QUEUE_MAX) {
        await sleep(100);
        continue;
      }
      const job = queues.folders.shift();
      if (!job) {
        if (activeWalkers === 0) return;
        await sleep(25);
        continue;
      }
      activeWalkers += 1;
      try {
        await walkFolder(drive, job, ctx);
      } catch (err) {
        // A failed subtree must not sink the whole run; it is logged and the
        // final exit code is non-zero so a re-run can pick it up.
        recordFailure(ctx, `folder ${job.name}`, err);
      } finally {
        activeWalkers -= 1;
      }
    }
  };

  const copier = async () => {
    for (;;) {
      if (ctx.aborted) return;
      const job = queues.files.shift();
      if (!job) {
        if (walkFinished) return;
        await sleep(25);
        continue;
      }
      try {
        await copyFile(drive, job, ctx);
      } catch (err) {
        recordFailure(ctx, `file ${job.name}`, err);
        stats.filesFailed += 1;
      }
    }
  };

  const walking = Promise.all(
    Array.from({ length: WALK_CONCURRENCY }, () => walker()),
  ).then(() => {
    walkFinished = true;
    ctx.walkState.done = !ctx.aborted;
  });

  const copying = Promise.all(Array.from({ length: COPY_CONCURRENCY }, () => copier()));

  await Promise.all([walking, copying]);
}

async function main() {
  if (!SOURCE_FOLDER_ID || !TARGET_FOLDER_ID) {
    console.error(
      'Set SOURCE_FOLDER_ID and TARGET_FOLDER_ID (folder IDs from the Drive URL).\nExample (PowerShell):\n  $env:SOURCE_FOLDER_ID="..."; $env:TARGET_FOLDER_ID="..."; npm start',
    );
    process.exit(1);
  }

  if (SOURCE_FOLDER_ID === TARGET_FOLDER_ID) {
    console.error('SOURCE_FOLDER_ID and TARGET_FOLDER_ID must be different folders.');
    process.exit(1);
  }

  // Fixed per-call sleeps were replaced by the adaptive governor; a stale value
  // in .env would otherwise look like it was still doing something.
  const retired = ['DRIVE_REQUEST_DELAY_MS', 'SCAN_REQUEST_DELAY_MS', 'SKIP_PRE_SCAN'].filter(
    (k) => process.env[k],
  );
  if (retired.length || process.argv.includes('--skip-scan')) {
    console.warn(
      `[note] Ignoring retired settings: ${[...retired, ...(process.argv.includes('--skip-scan') ? ['--skip-scan'] : [])].join(', ')}. ` +
        'Throughput is now controlled by READ_RATE / WRITE_RATE / WALK_CONCURRENCY / COPY_CONCURRENCY.',
    );
  }

  await acquireLock();

  const auth = await authorize();
  const drive = google.drive({ version: 'v3', auth });

  const stats = {
    foldersCreated: 0,
    foldersReused: 0,
    foldersDeduped: 0,
    foldersAmbiguous: 0,
    filesCopied: 0,
    filesSkipped: 0,
    filesReplaced: 0,
    filesFailed: 0,
    skippedShortcuts: 0,
    errors: 0,
  };

  const sourceIds = new Set([SOURCE_FOLDER_ID]);
  const visited = new Set([SOURCE_FOLDER_ID]);
  const walkState = { foldersWalked: 0, filesFound: 0, done: false };
  const runtime = { currentFile: 'starting…', currentFolder: '' };
  const queues = { folders: new Queue(), files: new Queue() };

  queues.folders.push({
    sourceId: SOURCE_FOLDER_ID,
    targetId: TARGET_FOLDER_ID,
    name: '/',
    targetKnownEmpty: false,
  });

  const ctx = {
    stats,
    walkState,
    runtime,
    queues,
    sourceIds,
    visited,
    copyMode: COPY_MODE,
    failures: [],
    aborted: false,
  };

  console.log('Source folder will not be modified (list + copy only).');
  if (COPY_MODE === 'skip') {
    console.log(
      'Mode: --continue-if-incomplete (default) — skip files already in target; copy only missing.',
    );
  } else {
    console.log(
      'Mode: --continue-with-re-copy — replace same-named target files, then copy missing.',
    );
  }
  console.log('Starting recursive copy…');
  console.log(`  Source folder: ${SOURCE_FOLDER_ID}`);
  console.log(`  Target parent: ${TARGET_FOLDER_ID}`);
  console.log(
    `  Workers: ${WALK_CONCURRENCY} walkers, ${COPY_CONCURRENCY} copiers | rate: ${READ_RATE}→${READ_RATE_MAX}/s read, ${WRITE_RATE}→${WRITE_RATE_MAX}/s write (adaptive)`,
  );
  if (VERBOSE) console.log('  Verbose per-file logs enabled.');
  console.log(`  Status printed every ${LOG_INTERVAL_MS}ms (2 lines per tick).`);

  const status = createStatusLogger(stats, walkState, runtime, queues);

  let interrupted = false;
  const onInterrupt = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    ctx.aborted = true;
    console.log('\n[abort] Finishing in-flight requests… (Ctrl+C again to force quit)');
  };
  process.on('SIGINT', onInterrupt);

  status.start();
  try {
    await runPools(drive, ctx);
  } finally {
    status.stop();
    process.off('SIGINT', onInterrupt);
    await issueLogChain;
    await releaseLock();
  }

  console.log(ctx.aborted ? '\nInterrupted.' : '\nDone.');
  console.log(`  Folders created: ${stats.foldersCreated}`);
  console.log(`  Folders reused:  ${stats.foldersReused}`);
  console.log(`  Files copied:    ${stats.filesCopied}`);
  if (stats.filesSkipped) {
    console.log(`  Files skipped:   ${stats.filesSkipped} (already present in target)`);
  }
  if (stats.filesReplaced) {
    console.log(`  Files replaced:  ${stats.filesReplaced} (removed same-named target file(s) before copy)`);
  }
  if (stats.foldersDeduped) {
    console.log(`  Folders deduped: ${stats.foldersDeduped} (multi-parent source folders walked once)`);
  }
  if (stats.foldersAmbiguous) {
    console.log(`  Folders ambiguous: ${stats.foldersAmbiguous} (duplicate names in target; used first — see ${ISSUE_LOG})`);
  }
  if (stats.skippedShortcuts) {
    console.log(`  Shortcuts skipped: ${stats.skippedShortcuts} (copy targets manually if needed)`);
  }
  console.log(`  API calls:       ${apiStats.calls}${apiStats.retries ? ` (${apiStats.retries} retried)` : ''}`);
  console.log(
    `  Final rates:     ${governors.read.rate.toFixed(1)}/s read, ${governors.write.rate.toFixed(1)}/s write` +
      `${governors.write.penalties || governors.read.penalties ? ` (${governors.read.penalties + governors.write.penalties} throttle events)` : ''}`,
  );

  if (stats.errors) {
    console.log(`  Errors:          ${stats.errors} (see ${ISSUE_LOG})`);
    for (const line of ctx.failures.slice(0, 10)) console.log(`    - ${line}`);
    if (ctx.failures.length > 10) console.log(`    …and more in ${ISSUE_LOG}`);
    console.log('  Re-run with --continue-if-incomplete to retry the missing items.');
    process.exitCode = 1;
  }
  if (ctx.aborted) process.exitCode = 130;
}

// Guarded so tests can import the pool internals without starting a migration.
const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  main().catch(async (err) => {
    await releaseLock();
    console.error(err.response?.data ?? err);
    process.exit(1);
  });
}

export {
  Queue,
  RateGovernor,
  runPools,
  walkFolder,
  copyFile,
  governors,
  acquireLock,
  releaseLock,
  LOCK_PATH,
};
