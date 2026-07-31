/**
 * Copies only the files that are missing from the target, matched by full path.
 *
 * Concurrency model (same architecture as index.js)
 *   - Phase 1: one folder queue drained by WALK_CONCURRENCY workers, seeded
 *     with both roots, so the source and target trees are mapped concurrently
 *     in a single pool.
 *   - Phase 2: the missing set is computed, then a queue of missing files is
 *     drained by COPY_CONCURRENCY copiers.
 *   - Every request goes through the shared adaptive governor (separate read
 *     and write buckets), so a 403/429 slows the whole fleet at once.
 *
 * Why the two phases do not overlap the way index.js does: a source file is
 * only "missing" once the *entire* target map is known, so the missing count
 * cannot be reported — and no copy can be safely started — before both walks
 * finish. index.js can overlap because it decides per folder, from a listing it
 * already has in hand.
 *
 * Folder creation is safe under concurrency: a path is created by exactly one
 * copier, and everyone else awaits that same in-flight create (see ensureFolder).
 */

import { google } from 'googleapis';
import fs from 'fs/promises';

import {
  apiStats,
  COPY_CONCURRENCY,
  createStatusPrinter,
  createWalkContext,
  driveCall,
  flushIssues,
  FOLDER_MIME,
  formatDuration,
  governors,
  isMainModule,
  ISSUE_LOG,
  Queue,
  READ_RATE,
  READ_RATE_MAX,
  recordFailure,
  truncateName,
  WALK_CONCURRENCY,
  walkTrees,
  WRITE_RATE,
  WRITE_RATE_MAX,
} from './driveUtils.js';

const CREDENTIALS_PATH = './credentials.json';
const TOKEN_PATH = './token.json';

// Auth
async function getAuth() {
  const credentials = JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf8'));
  const { client_id, client_secret, redirect_uris } =
    credentials.installed || credentials.web;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  const token = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);

  return oAuth2Client;
}

// Create one folder and record it in the cache under its full path.
async function createFolder(drive, name, parentId, fullPath, ctx) {
  const res = await driveCall('write', `files.create folder ${fullPath}`, () =>
    drive.files.create({
      requestBody: {
        name,
        mimeType: FOLDER_MIME,
        parents: [parentId],
      },
      fields: 'id',
      supportsAllDrives: true,
    }),
  );

  const id = res.data.id;
  if (!id) throw new Error(`Folder create returned no id for ${fullPath}`);

  ctx.folderCache.set(fullPath, id);
  ctx.stats.foldersCreated += 1;

  console.log(`📁 Created folder: ${fullPath}`);
  return id;
}

// Ensure folder path exists in target
async function ensureFolder(drive, pathParts, rootId, ctx) {
  let parentId = rootId;
  let currentPath = '';

  for (const part of pathParts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;

    const cached = ctx.folderCache.get(currentPath);
    if (cached) {
      parentId = cached;
      continue;
    }

    // Several copiers can want the same missing folder at the same moment. The
    // first one here owns the create and everyone else awaits its promise, so a
    // path is created exactly once even with COPY_CONCURRENCY workers running.
    // The cache lookup above and this claim are both synchronous, so no worker
    // can slip between them — the check-then-create race that produces
    // duplicate folders cannot happen.
    let inFlight = ctx.pendingFolders.get(currentPath);
    if (!inFlight) {
      inFlight = createFolder(drive, part, parentId, currentPath, ctx);
      ctx.pendingFolders.set(currentPath, inFlight);
      // Cleared on settle either way: a failed create must not be left behind
      // as a permanently pending promise that later copiers await forever.
      const forget = () => ctx.pendingFolders.delete(currentPath);
      inFlight.then(forget, forget);
    }
    parentId = await inFlight;
  }

  return parentId;
}

async function copyMissing(drive, fullPath, ctx) {
  const file = ctx.sourceFiles.get(fullPath);
  const parts = fullPath.split('/');
  const fileName = parts.pop();

  const parentId = await ensureFolder(drive, parts, ctx.targetRootId, ctx);

  ctx.runtime.currentFile = fileName;
  console.log(`📄 Copying: ${fullPath}`);

  await driveCall('write', `files.copy ${fullPath}`, () =>
    drive.files.copy({
      fileId: file.id,
      requestBody: {
        name: fileName,
        parents: [parentId],
      },
      fields: 'id',
      supportsAllDrives: true,
    }),
  );

  ctx.stats.filesCopied += 1;
}

/** Drains the missing-file queue with COPY_CONCURRENCY workers. */
async function runCopiers(drive, ctx) {
  const copier = async () => {
    for (;;) {
      if (ctx.aborted) return;
      const fullPath = ctx.queues.files.shift();
      if (fullPath === undefined) return;
      try {
        await copyMissing(drive, fullPath, ctx);
      } catch (err) {
        // One bad file (or one folder we cannot create) must not end the run;
        // it is logged and the exit code reports that a re-run is needed.
        recordFailure(ctx, `file ${fullPath}`, err);
        ctx.stats.filesFailed += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: COPY_CONCURRENCY }, () => copier()));
}

/** Two-line status block: [progress] work done, [scan] queue + API health. */
function createStatusLogger(ctx, phase) {
  const startedAt = Date.now();

  return createStatusPrinter(() => {
    const { source, target } = ctx.scan;
    const elapsedMs = Date.now() - startedAt;

    if (phase.name === 'map') {
      const progress = [
        `[progress] source ${source.files} files / ${source.folders} folders`,
        `target ${target.files} files / ${target.folders} folders`,
      ];
      if (ctx.stats.errors) progress.push(`${ctx.stats.errors} errors`);
      progress.push(`elapsed ${formatDuration(elapsedMs)}`);

      const scan = [
        ctx.done ? '[scan] mapping complete' : '[scan] mapping…',
        `queue: ${ctx.queues.folders.size} folders`,
        `api ${governors.read.rate.toFixed(1)}/s read`,
      ];
      if (apiStats.retries) scan.push(`${apiStats.retries} retries`);
      scan.push(`in: ${truncateName(ctx.runtime.currentFolder || '/', 40)}`);

      return [progress.join(' | '), scan.join(' | ')];
    }

    const copied = ctx.stats.filesCopied;
    const rate = copied / Math.max(1, elapsedMs / 1000);
    const remaining = Math.max(0, phase.total - copied - ctx.stats.filesFailed);

    const progress = [
      `[progress] ${copied}/${phase.total} copied`,
      `${ctx.stats.foldersCreated} folders created`,
    ];
    if (ctx.stats.filesFailed) progress.push(`${ctx.stats.filesFailed} failed`);
    progress.push(
      `${rate.toFixed(1)} files/s`,
      `elapsed ${formatDuration(elapsedMs)}`,
      `ETA ${rate > 0 ? formatDuration((remaining / rate) * 1000) : '--:--:--'}`,
    );

    const scan = [
      '[scan] copying…',
      `queue: ${ctx.queues.files.size} files`,
      `api ${governors.write.rate.toFixed(1)}/s write`,
    ];
    if (apiStats.retries) scan.push(`${apiStats.retries} retries`);
    scan.push(`now: ${truncateName(ctx.runtime.currentFile, 34)}`);

    return [progress.join(' | '), scan.join(' | ')];
  });
}

// MAIN
async function main() {
  const SOURCE = process.env.SOURCE_FOLDER_ID;
  const TARGET = process.env.TARGET_FOLDER_ID;

  if (!SOURCE || !TARGET) {
    console.error('Set SOURCE_FOLDER_ID and TARGET_FOLDER_ID');
    process.exit(1);
  }

  const auth = await getAuth();
  const drive = google.drive({ version: 'v3', auth });

  // path -> source file, path -> target file, path -> existing target folder id
  const sourceFiles = new Map();
  const targetFiles = new Map();
  const targetFolders = new Map();

  const ctx = createWalkContext({
    targetRootId: TARGET,
    sourceFiles,
    queues: { folders: new Queue(), files: new Queue() },
    folderCache: new Map(),
    pendingFolders: new Map(),
    onFile(side, fullPath, file) {
      (side === 'source' ? sourceFiles : targetFiles).set(fullPath, file);
    },
    onFolder(side, fullPath, folder) {
      // First one wins, so a duplicate-named target folder is reused rather
      // than adding a second copy of the same path.
      if (side === 'target' && !targetFolders.has(fullPath)) {
        targetFolders.set(fullPath, folder.id);
      }
    },
  });
  ctx.stats.foldersCreated = 0;
  ctx.stats.filesCopied = 0;
  ctx.stats.filesFailed = 0;

  let interrupted = false;
  const onInterrupt = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    ctx.aborted = true;
    console.log('\n[abort] Finishing in-flight requests… (Ctrl+C again to force quit)');
  };
  process.on('SIGINT', onInterrupt);

  // Both walks share one worker pool and start together.
  console.log('📂 Mapping source...');
  console.log('📂 Mapping target...');
  console.log(
    `   ${WALK_CONCURRENCY} walkers, ${COPY_CONCURRENCY} copiers | rate: ${READ_RATE}→${READ_RATE_MAX}/s read, ${WRITE_RATE}→${WRITE_RATE_MAX}/s write (adaptive)`,
  );

  const phase = { name: 'map', total: 0 };
  let status = createStatusLogger(ctx, phase);
  status.start();
  try {
    await walkTrees(
      drive,
      [
        { side: 'source', id: SOURCE },
        { side: 'target', id: TARGET },
      ],
      ctx,
    );
    ctx.done = !ctx.aborted;
  } finally {
    status.stop();
  }

  if (ctx.stats.errors) {
    // Files under a folder we could not list are invisible to us; treating them
    // as missing would re-copy files that already exist in the target.
    console.error(
      `\n❌ ${ctx.stats.errors} folders could not be listed — the maps are incomplete, so "missing" cannot be trusted (see ${ISSUE_LOG}).`,
    );
    for (const line of ctx.failures.slice(0, 10)) console.error(`    - ${line}`);
    await flushIssues();
    process.off('SIGINT', onInterrupt);
    process.exit(1);
  }

  if (ctx.aborted) {
    console.log('\nInterrupted before mapping finished — nothing was copied.');
    await flushIssues();
    process.off('SIGINT', onInterrupt);
    process.exit(130);
  }

  // Sorted rather than in traversal order: a concurrent walk has no stable
  // order, and sorting groups each folder's files so the folder cache is warm.
  const missing = [...sourceFiles.keys()].filter(k => !targetFiles.has(k)).sort();

  console.log(`\n❌ Missing files to copy: ${missing.length}\n`);

  // Pre-seed the folder cache with existing target folders so we reuse them
  // instead of creating duplicates.
  ctx.folderCache = new Map(targetFolders);
  for (const p of missing) ctx.queues.files.push(p);

  phase.name = 'copy';
  phase.total = missing.length;
  status = createStatusLogger(ctx, phase);

  if (missing.length) status.start();
  try {
    await runCopiers(drive, ctx);
  } finally {
    if (missing.length) status.stop();
    process.off('SIGINT', onInterrupt);
    await flushIssues();
  }

  console.log(ctx.aborted ? '\n⏹️ Interrupted.' : '\n✅ Missing files copied.');
  console.log(`  Files copied:    ${ctx.stats.filesCopied}`);
  console.log(`  Folders created: ${ctx.stats.foldersCreated}`);
  console.log(
    `  API calls:       ${apiStats.calls}${apiStats.retries ? ` (${apiStats.retries} retried)` : ''} | ` +
    `final ${governors.read.rate.toFixed(1)}/s read, ${governors.write.rate.toFixed(1)}/s write`,
  );

  if (ctx.stats.errors) {
    console.log(`  Errors:          ${ctx.stats.errors} (see ${ISSUE_LOG})`);
    for (const line of ctx.failures.slice(0, 10)) console.log(`    - ${line}`);
    if (ctx.failures.length > 10) console.log(`    …and more in ${ISSUE_LOG}`);
    console.log('  Re-run this script to retry the failed items.');
    process.exitCode = 1;
  }
  if (ctx.aborted) process.exitCode = 130;
}

// Guarded so tests can import the pool internals without starting a copy.
if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error(err.response?.data || err);
    process.exit(1);
  });
}

export { copyMissing, createFolder, ensureFolder, main, runCopiers };
