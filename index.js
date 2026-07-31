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
import {
  apiStats,
  appendIssue,
  COPY_CONCURRENCY,
  createStatusPrinter,
  driveCall,
  FILE_QUEUE_MAX,
  flushIssues,
  FOLDER_MIME,
  formatDuration,
  governors,
  ISSUE_LOG,
  listChildren,
  LOG_INTERVAL_MS,
  Queue,
  RateGovernor,
  READ_RATE,
  READ_RATE_MAX,
  recordFailure,
  SHORTCUT_MIME,
  sleep,
  truncateName,
  VERBOSE,
  WALK_CONCURRENCY,
  WRITE_RATE,
  WRITE_RATE_MAX,
} from './driveUtils.js';
dotenv.config();

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

console.log({
  CREDENTIALS_PATH,
  SOURCE_FOLDER_ID,
  TARGET_FOLDER_ID,
  TOKEN_PATH
})

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

  return createStatusPrinter(() => {
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

    return [progress.join(' | '), scan.join(' | ')];
  });
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
    await flushIssues();
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
