/**
 * Migrates a shared folder tree into the authenticated (target) user's Drive
 * using drive.files.list + drive.files.create (folders) + drive.files.copy (files).
 * Native Google Workspace files stay native (no export/import).
 *
 * The SOURCE folder is read-only: list + copy only. Deletes apply to duplicate
 * TARGET *files* only, in the two --continue-with-re-copy* modes; never to
 * source items and never to a folder on either side.
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
 *   --continue-with-re-copy-handled-duplicates
 *                              same file handling as --continue-with-re-copy, but
 *                              same-named sibling folders are mirrored one-for-one
 *                              instead of being merged into the first match
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { google } from 'googleapis';
import {
  apiStats,
  appendErrorDetail,
  appendIssue,
  compareByCreatedTime,
  compareIds,
  COPY_CONCURRENCY,
  createStatusPrinter,
  driveCall,
  ERROR_DETAIL_LOG,
  FILE_QUEUE_MAX,
  findChildFoldersByName,
  flushIssues,
  FOLDER_MIME,
  formatDuration,
  governors,
  isMainModule,
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
  tagFailure,
  truncateName,
  VERBOSE,
  withKeyedLock,
  WALK_CONCURRENCY,
  WRITE_RATE,
  WRITE_RATE_MAX,
} from './driveUtils.js';

// Exact argv matches, so --continue-with-re-copy-handled-duplicates does not
// also read as --continue-with-re-copy.
const CONTINUE_FLAGS = [
  '--continue-if-incomplete',
  '--continue-with-re-copy',
  '--continue-with-re-copy-handled-duplicates',
].filter((flag) => process.argv.includes(flag));

if (CONTINUE_FLAGS.length > 1) {
  console.error(
    `Use only one continue mode at a time (got ${CONTINUE_FLAGS.join(', ')}).\n` +
      'Pick one of --continue-if-incomplete, --continue-with-re-copy or --continue-with-re-copy-handled-duplicates.',
  );
  process.exit(1);
}

const WANT_HANDLED_DUPLICATES = CONTINUE_FLAGS[0] === '--continue-with-re-copy-handled-duplicates';
const WANT_CONTINUE_WITH_RE_COPY = CONTINUE_FLAGS[0] === '--continue-with-re-copy';

/** 'skip' = resume without re-copying; 'recopy' = replace existing target files. */
const COPY_MODE = WANT_CONTINUE_WITH_RE_COPY || WANT_HANDLED_DUPLICATES ? 'recopy' : 'skip';

/**
 * 'reuse-by-name'       one target folder per name — same-named source siblings
 *                       all end up in the same target folder (long-standing
 *                       behaviour of the other two modes)
 * 'preserve-duplicates' one target folder per source folder, paired by ordinal
 *                       so a re-run adopts the folders it made last time
 */
const FOLDER_MODE = WANT_HANDLED_DUPLICATES ? 'preserve-duplicates' : 'reuse-by-name';

const MODE_LABEL = WANT_HANDLED_DUPLICATES
  ? '--continue-with-re-copy-handled-duplicates'
  : WANT_CONTINUE_WITH_RE_COPY
    ? '--continue-with-re-copy'
    : '--continue-if-incomplete (default)';

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

/**
 * Slash path of a child, with '/' as each tree's root. Carried on every job so
 * a failure can be reported as a location, not just a bare file name — two
 * folders can hold files with the same name, which is precisely the case the
 * detail log exists to disambiguate.
 */
function childPath(parentPath, name) {
  return parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
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
 * reuse-by-name: resolve-or-create one target folder for `name`.
 *
 * Serialized per (target parent + name) and reads the target from Drive rather
 * than from the parent listing this walker already has. That snapshot only
 * reflects folders present when the parent was listed, so a subtree left by an
 * earlier partial run — or a duplicate created earlier in this run — is
 * invisible to it, and the old code would create a second copy. The
 * authoritative lookup inside the lock closes that window: any existing folder
 * is adopted, and only one create can win per name.
 */
async function resolveFolderByName(drive, job, item, ctx) {
  const { stats, copyMode, folderMode } = ctx;
  const { id, name, mimeType } = item;
  let targetId;
  let targetKnownEmpty = false;

  await withKeyedLock(`folder:${job.targetId}:${name}`, async () => {
    const existingFolders = await findChildFoldersByName(drive, job.targetId, name).catch((err) => {
      throw tagFailure(err, 'files.list', {
        side: 'target',
        failedFileId: job.targetId,
        sourceFile: { id, name, mimeType },
      });
    });

    if (existingFolders.length > 0) {
      targetId = existingFolders[0].id;
      stats.foldersReused += 1;
      if (existingFolders.length > 1) {
        // Pre-existing duplicates in the target (e.g. left by a run made
        // before this fix). Reported, not created — this branch never adds
        // a folder, so it cannot make the situation worse.
        stats.foldersAmbiguous += 1;
        const message = `${existingFolders.length} target folders named "${name}"; continuing in the first`;
        appendIssue('ambiguous-folder', message);
        appendErrorDetail('ambiguous-folder', `folder ${name}`, message, {
          operation: 'files.list',
          copyMode,
          folderMode,
          sourceFile: { id, name, mimeType },
          targetFile: { id: targetId, name },
          sourceFolder: { id: job.sourceId, path: job.sourcePath },
          targetFolder: { id: job.targetId, path: job.targetPath },
          targetFileIds: existingFolders.map((f) => f.id),
        });
      }
      if (VERBOSE) console.log(`Using existing folder: ${name}`);
    } else {
      targetId = await createTargetFolder(drive, job, item);
      stats.foldersCreated += 1;
      targetKnownEmpty = true;
      if (VERBOSE) console.log(`Created folder: ${name}`);
    }
  });

  return { targetId, targetKnownEmpty };
}

async function createTargetFolder(drive, job, item) {
  const { id, name, mimeType } = item;
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
  ).catch((err) => {
    // The id sent to files.create is the parent the folder goes into.
    throw tagFailure(err, 'files.create', {
      failedFileId: job.targetId,
      sourceFile: { id, name, mimeType },
    });
  });

  const targetId = created.data.id;
  if (!targetId) throw new Error(`Folder create returned no id for ${name}`);
  return targetId;
}

/**
 * preserve-duplicates: dense ordinals for the same-named child folders of one
 * source parent, so each gets its own target folder instead of all of them
 * collapsing into the first.
 *
 * Sorted by id, not by listing order: Drive promises no order, and a resume
 * that saw its sources in a different order would pair them against the wrong
 * target subtrees. Multi-parent folders already walked elsewhere are dropped
 * here rather than skipped later, so the ordinals stay dense — a gap would ask
 * for a target folder at an index that can never exist, and every re-run would
 * create one more.
 *
 * Runs synchronously, so the visited check and claim cannot interleave with
 * another walker's.
 */
function planFolderOrdinals(children, visited, stats) {
  const groups = new Map();
  for (const item of children) {
    if (item.mimeType !== FOLDER_MIME || !item.id || !item.name) continue;
    const bucket = groups.get(item.name);
    if (bucket) bucket.push(item);
    else groups.set(item.name, [item]);
  }

  const slots = new Map();
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => compareIds(a.id, b.id));
    const walkable = [];
    for (const item of bucket) {
      // Drive allows an item to have several parents, so the same folder can
      // surface under two listings. Walk it once or it gets copied twice.
      if (visited.has(item.id)) {
        stats.foldersDeduped += 1;
        continue;
      }
      visited.add(item.id);
      walkable.push(item);
    }
    walkable.forEach((item, ordinal) => slots.set(item.id, { ordinal, group: walkable }));
  }

  return slots;
}

/**
 * preserve-duplicates: gives every same-named source sibling its own target
 * folder, creating whatever is missing.
 *
 * The whole group is resolved in one pass under one lock so creation order
 * matches ordinal order — that is what lets the next run re-pair by ordinal.
 * Existing targets are adopted oldest-first, extras beyond the source count are
 * left untouched, and nothing is ever deleted.
 */
async function pairFolderGroup(drive, job, name, group, ctx) {
  const { stats, copyMode, folderMode } = ctx;
  const paired = [];

  await withKeyedLock(`folder:${job.targetId}:${name}`, async () => {
    const existing = await findChildFoldersByName(drive, job.targetId, name).catch((err) => {
      throw tagFailure(err, 'files.list', {
        side: 'target',
        failedFileId: job.targetId,
        sourceFile: { id: group[0].id, name, mimeType: FOLDER_MIME },
      });
    });
    existing.sort(compareByCreatedTime);

    for (let ordinal = 0; ordinal < group.length; ordinal += 1) {
      if (ordinal < existing.length) {
        paired.push({ targetId: existing[ordinal].id, targetKnownEmpty: false });
        stats.foldersReused += 1;
        if (VERBOSE) {
          console.log(`Using existing folder: ${name} [${ordinal + 1}/${group.length}]`);
        }
        continue;
      }
      const targetId = await createTargetFolder(drive, job, group[ordinal]);
      paired.push({ targetId, targetKnownEmpty: true });
      stats.foldersCreated += 1;
      if (VERBOSE) console.log(`Created folder: ${name} [${ordinal + 1}/${group.length}]`);
    }

    if (existing.length > group.length) {
      stats.foldersAmbiguous += 1;
      const message =
        `${existing.length} target folders named "${name}" but ${group.length} in source; ` +
        `paired the ${group.length} oldest, left ${existing.length - group.length} untouched`;
      appendIssue('ambiguous-folder', message);
      appendErrorDetail('ambiguous-folder', `folder ${name}`, message, {
        operation: 'files.list',
        copyMode,
        folderMode,
        sourceFolder: { id: job.sourceId, path: job.sourcePath },
        targetFolder: { id: job.targetId, path: job.targetPath },
        sourceFileIds: group.map((f) => f.id),
        targetFileIds: existing.map((f) => f.id),
      });
    }
  });

  return paired;
}

/**
 * Mirrors one source folder into its target counterpart: creates/reuses child
 * folders, enqueues child folders for other walkers, and enqueues file copies.
 *
 * This is the only place that writes into `job.targetId`, and each source
 * folder reaches it exactly once — that is what rules out duplicate folders.
 */
async function walkFolder(drive, job, ctx) {
  const { stats, walkState, runtime, queues, sourceIds, visited, copyMode, folderMode } = ctx;
  runtime.currentFolder = job.name;
  sourceIds.add(job.sourceId);

  // Tagged per side: both are files.list, and the walker that logs the failure
  // cannot otherwise tell which of the two trees it could not read.
  const [children, targetChildren] = await Promise.all([
    listChildren(drive, job.sourceId).catch((err) => {
      throw tagFailure(err, 'files.list', { side: 'source', failedFileId: job.sourceId });
    }),
    // A folder this run just created is known-empty; listing it is a wasted call.
    job.targetKnownEmpty
      ? Promise.resolve([])
      : listChildren(drive, job.targetId).catch((err) => {
          throw tagFailure(err, 'files.list', { side: 'target', failedFileId: job.targetId });
        }),
  ]);

  const targetByName = new Map();
  for (const child of targetChildren) {
    if (!child.name) continue;
    const bucket = targetByName.get(child.name);
    if (bucket) bucket.push(child);
    else targetByName.set(child.name, [child]);
  }

  // preserve-duplicates claims every walkable child folder up front and resolves
  // each name group in one shot, so ordinals and creation order agree.
  const folderPlan =
    folderMode === 'preserve-duplicates' ? planFolderOrdinals(children, visited, stats) : null;
  const pairedGroups = new Map();

  for (const item of children) {
    const { id, name, mimeType } = item;
    if (!id || !name) continue;
    sourceIds.add(id);

    if (mimeType === FOLDER_MIME) {
      let targetId;
      let targetKnownEmpty = false;

      if (folderPlan) {
        const slot = folderPlan.get(id);
        // Absent means the plan already counted it as a multi-parent folder
        // walked under another parent.
        if (!slot) continue;
        let paired = pairedGroups.get(name);
        if (!paired) {
          paired = await pairFolderGroup(drive, job, name, slot.group, ctx);
          pairedGroups.set(name, paired);
        }
        ({ targetId, targetKnownEmpty } = paired[slot.ordinal]);
      } else {
        // Drive allows an item to have several parents, so the same folder can
        // surface under two listings. Walk it once or it gets copied twice.
        if (visited.has(id)) {
          stats.foldersDeduped += 1;
          continue;
        }
        visited.add(id);
        ({ targetId, targetKnownEmpty } = await resolveFolderByName(drive, job, item, ctx));
      }

      queues.folders.push({
        sourceId: id,
        targetId,
        name,
        targetKnownEmpty,
        sourcePath: childPath(job.sourcePath, name),
        targetPath: childPath(job.targetPath, name),
      });
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
      mimeType,
      sourceFolderId: job.sourceId,
      sourcePath: job.sourcePath,
      targetParentId: job.targetId,
      targetPath: job.targetPath,
      existing: copyMode === 'recopy' ? existingSameName : [],
      enqueuedAt: Date.now(),
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
      // Tagged so a failed delete is logged as the delete it was, against the
      // target id — not as a copy failure against the source id.
      await deleteTargetFileIfExists(drive, existing.id, job.name, sourceIds).catch((err) => {
        throw tagFailure(err, 'files.delete', {
          failedFileId: existing.id,
          targetFile: { id: existing.id, name: existing.name ?? job.name },
        });
      });
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
        recordFailure(ctx, `folder ${job.name}`, err, {
          operation: 'files.list',
          copyMode: ctx.copyMode,
          folderMode: ctx.folderMode,
          sourceFolder: { id: job.sourceId, path: job.sourcePath },
          targetFolder: { id: job.targetId, path: job.targetPath },
        });
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
        recordFailure(ctx, `file ${job.name}`, err, {
          operation: 'files.copy',
          copyMode: ctx.copyMode,
          folderMode: ctx.folderMode,
          enqueuedAt: job.enqueuedAt,
          sourceFile: { id: job.sourceId, name: job.name, mimeType: job.mimeType },
          // Same-named file(s) already in the target: empty in skip mode, since
          // a file with one would never have been queued.
          targetFile: job.existing[0]
            ? { id: job.existing[0].id, name: job.existing[0].name ?? job.name }
            : undefined,
          sourceFolder: { id: job.sourceFolderId, path: job.sourcePath },
          targetFolder: { id: job.targetParentId, path: job.targetPath },
          failedFileId: job.sourceId,
          targetFileIds: job.existing.map((e) => e.id),
        });
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
    sourcePath: '/',
    targetPath: '/',
  });

  const ctx = {
    stats,
    walkState,
    runtime,
    queues,
    sourceIds,
    visited,
    copyMode: COPY_MODE,
    folderMode: FOLDER_MODE,
    failures: [],
    aborted: false,
  };

  console.log('Source folder will not be modified (list + copy only).');
  if (FOLDER_MODE === 'preserve-duplicates') {
    console.log(
      `Mode: ${MODE_LABEL} — replace same-named target files, then copy missing;`,
    );
    console.log(
      '      same-named sibling folders are mirrored one-for-one instead of merged.',
    );
  } else if (COPY_MODE === 'recopy') {
    console.log(
      `Mode: ${MODE_LABEL} — replace same-named target files, then copy missing.`,
    );
  } else {
    console.log(
      `Mode: ${MODE_LABEL} — skip files already in target; copy only missing.`,
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
  console.log(`  Mode:            ${MODE_LABEL} (files: ${COPY_MODE}, folders: ${FOLDER_MODE})`);
  console.log(`  Folders created: ${stats.foldersCreated}`);
  console.log(
    `  Folders reused:  ${stats.foldersReused}` +
      (FOLDER_MODE === 'preserve-duplicates' ? ' (paired by ordinal within each name)' : ''),
  );
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
    console.log(
      FOLDER_MODE === 'preserve-duplicates'
        ? `  Folders ambiguous: ${stats.foldersAmbiguous} (more same-named folders in target than source; extras left untouched — see ${ISSUE_LOG})`
        : `  Folders ambiguous: ${stats.foldersAmbiguous} (duplicate names in target; used first — see ${ISSUE_LOG})`,
    );
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
    console.log(`  Errors:          ${stats.errors} (see ${ISSUE_LOG}; full context in ${ERROR_DETAIL_LOG})`);
    for (const line of ctx.failures.slice(0, 10)) console.log(`    - ${line}`);
    if (ctx.failures.length > 10) console.log(`    …and more in ${ISSUE_LOG}`);
    console.log('  Re-run with --continue-if-incomplete to retry the missing items.');
    process.exitCode = 1;
  }
  if (ctx.aborted) process.exitCode = 130;
}

// Guarded so tests can import the pool internals without starting a migration.
if (isMainModule(import.meta.url)) {
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